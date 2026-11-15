import "server-only";
import { redis } from "@/lib/redis";
import { logError } from "@/lib/logger";

/**
 * Continuously refilling token buckets shared across serverless isolates.
 *
 * A bucket holds up to `capacity` tokens and refills at `refillPerMs`. A
 * reservation names one or more buckets and is all-or-nothing: either every
 * bucket can afford its `cost` (and they are all debited), or nothing changes
 * and the caller is told how long until the reservation would fit. That lets
 * one model call be checked against several limits at once (combined, input
 * and output tokens per minute) without partial debits.
 */
export type BucketSpec = {
  key: string;
  /** Tokens this reservation takes. Clamped to `capacity`. */
  cost: number;
  capacity: number;
  refillPerMs: number;
  /** Tokens that must remain *after* the debit for it to be granted. */
  headroom?: number;
};

export type BucketRef = Pick<BucketSpec, "key" | "capacity" | "refillPerMs">;

export type ReserveResult = { granted: boolean; waitMs: number };

export type BucketStore = {
  reserve(buckets: BucketSpec[], now: number): Promise<ReserveResult>;
  /** Lower a bucket to at most `remaining` tokens. Never raises it. */
  clamp(bucket: BucketRef, remaining: number, now: number): Promise<void>;
};

/** Bucket shape for an "N per minute" limit. */
export function perMinute(limit: number): { capacity: number; refillPerMs: number } {
  return { capacity: limit, refillPerMs: limit / 60_000 };
}

type BucketState = { tokens: number; ts: number };

/** Tokens available at `now`, given the last stored state. */
function refilled(
  state: BucketState | undefined,
  bucket: BucketRef,
  now: number,
): number {
  if (!state) return bucket.capacity;
  const elapsed = Math.max(0, now - state.ts);
  return Math.min(bucket.capacity, state.tokens + elapsed * bucket.refillPerMs);
}

/** Per-process store: used in tests and when Redis is unreachable. */
export function createMemoryBucketStore(): BucketStore {
  const states = new Map<string, BucketState>();
  return {
    async reserve(buckets, now) {
      let waitMs = 0;
      const plan = buckets.map((bucket) => {
        const tokens = refilled(states.get(bucket.key), bucket, now);
        const cost = Math.min(Math.max(0, bucket.cost), bucket.capacity);
        const need = Math.min(bucket.capacity, cost + Math.max(0, bucket.headroom ?? 0));
        if (tokens < need) {
          waitMs = Math.max(waitMs, Math.ceil((need - tokens) / bucket.refillPerMs));
        }
        return { bucket, tokens, cost };
      });
      if (waitMs > 0) return { granted: false, waitMs };
      for (const { bucket, tokens, cost } of plan) {
        states.set(bucket.key, { tokens: tokens - cost, ts: now });
      }
      return { granted: true, waitMs: 0 };
    },
    async clamp(bucket, remaining, now) {
      const tokens = refilled(states.get(bucket.key), bucket, now);
      states.set(bucket.key, {
        tokens: Math.min(tokens, Math.max(0, remaining)),
        ts: now,
      });
    },
  };
}

/**
 * KEYS: one per bucket. ARGV: now, then (cost, capacity, refillPerMs,
 * headroom) per bucket. Returns {granted, waitMs}. Mirrors
 * `createMemoryBucketStore().reserve`.
 */
const RESERVE_SCRIPT = `
local now = tonumber(ARGV[1])
local wait = 0
local plan = {}
for i = 1, #KEYS do
  local base = 1 + (i - 1) * 4
  local cost = tonumber(ARGV[base + 1])
  local cap = tonumber(ARGV[base + 2])
  local refill = tonumber(ARGV[base + 3])
  local headroom = tonumber(ARGV[base + 4])
  local raw = redis.call('HMGET', KEYS[i], 'tokens', 'ts')
  local tokens = tonumber(raw[1])
  local ts = tonumber(raw[2])
  if tokens == nil or ts == nil then
    tokens = cap
  else
    local elapsed = now - ts
    if elapsed < 0 then elapsed = 0 end
    tokens = math.min(cap, tokens + elapsed * refill)
  end
  if cost < 0 then cost = 0 end
  if cost > cap then cost = cap end
  if headroom < 0 then headroom = 0 end
  local need = math.min(cap, cost + headroom)
  if tokens < need then
    local w = math.ceil((need - tokens) / refill)
    if w > wait then wait = w end
  end
  plan[i] = { tokens, cost, cap, refill }
end
if wait > 0 then
  return { 0, wait }
end
for i = 1, #KEYS do
  local p = plan[i]
  redis.call('HSET', KEYS[i], 'tokens', tostring(p[1] - p[2]), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[i], math.ceil(p[3] / p[4]) + 1000)
end
return { 1, 0 }
`;

/** KEYS[1]: bucket. ARGV: now, remaining, capacity, refillPerMs. */
const CLAMP_SCRIPT = `
local now = tonumber(ARGV[1])
local remaining = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
local refill = tonumber(ARGV[4])
local raw = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(raw[1])
local ts = tonumber(raw[2])
if tokens == nil or ts == nil then
  tokens = cap
else
  local elapsed = now - ts
  if elapsed < 0 then elapsed = 0 end
  tokens = math.min(cap, tokens + elapsed * refill)
end
if remaining < 0 then remaining = 0 end
if remaining < tokens then tokens = remaining end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / refill) + 1000)
return 1
`;

/** Minimal Redis surface the bucket store needs (injectable for tests). */
export type BucketScriptDb = {
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
};

/** Redis-backed store: one atomic Lua call per reservation. */
export function createRedisBucketStore(db: BucketScriptDb): BucketStore {
  return {
    async reserve(buckets, now) {
      if (buckets.length === 0) return { granted: true, waitMs: 0 };
      const args = [String(now)];
      for (const b of buckets) {
        args.push(
          String(b.cost),
          String(b.capacity),
          String(b.refillPerMs),
          String(b.headroom ?? 0),
        );
      }
      const reply = (await db.eval(
        RESERVE_SCRIPT,
        buckets.map((b) => b.key),
        args,
      )) as unknown[];
      return {
        granted: Number(reply?.[0]) === 1,
        waitMs: Math.max(0, Number(reply?.[1]) || 0),
      };
    },
    async clamp(bucket, remaining, now) {
      await db.eval(
        CLAMP_SCRIPT,
        [bucket.key],
        [
          String(now),
          String(remaining),
          String(bucket.capacity),
          String(bucket.refillPerMs),
        ],
      );
    },
  };
}

/**
 * Use `primary`, and on any error fall back to `fallback` for that call.
 * Rate limiting must never take a request down: a per-process budget is a
 * worse limit than the shared one, but better than failing the turn.
 */
export function createFailOpenBucketStore(
  primary: () => BucketStore,
  fallback: BucketStore = createMemoryBucketStore(),
): BucketStore {
  return {
    async reserve(buckets, now) {
      try {
        return await primary().reserve(buckets, now);
      } catch (error) {
        logError("bucket-reserve", error, { keys: buckets.map((b) => b.key) });
        return fallback.reserve(buckets, now);
      }
    },
    async clamp(bucket, remaining, now) {
      try {
        await primary().clamp(bucket, remaining, now);
      } catch (error) {
        logError("bucket-clamp", error, { key: bucket.key });
        await fallback.clamp(bucket, remaining, now);
      }
    },
  };
}

let shared: BucketStore | undefined;

/** Process-wide store backed by Upstash Redis, failing open to memory. */
export function sharedBucketStore(): BucketStore {
  shared ??= createFailOpenBucketStore(() =>
    createRedisBucketStore(redis() as unknown as BucketScriptDb),
  );
  return shared;
}
