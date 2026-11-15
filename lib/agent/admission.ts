import "server-only";
import { serverConfig } from "@/lib/config";
import { logError } from "@/lib/logger";
import { redis } from "@/lib/redis";

/**
 * FIFO admission queue for research turns, shared across server instances.
 *
 * The model budgets only cover about one or two research turns a minute, so
 * starting every turn at once means they all wait on (or degrade against)
 * the same windows. Instead at most `maxConcurrentTurns` run; the rest hold
 * a ticket and are admitted strictly in arrival order.
 *
 * Nothing waits in here: a queued turn polls once per attempt, and its next
 * attempt polls again a little later (see lib/agent/turn.ts). Both a
 * running turn's slot and a queued turn's ticket expire unless they keep
 * being refreshed, so a turn that dies or is abandoned frees its place.
 */
export type AdmissionTicket = { id: string; enqueuedAt: number };

export type AdmissionState =
  | { state: "granted" }
  /** `position` is 1-based: 1 means next in line. */
  | { state: "queued"; position: number }
  | { state: "full"; queueLength: number };

type AdmissionLimits = {
  maxActive: number;
  maxQueue: number;
  leaseMs: number;
  ticketTtlMs: number;
};

export type AdmissionStore = {
  /** Join (or stay in) the queue and take a slot if it is this ticket's turn. */
  poll(ticket: AdmissionTicket, now: number, limits: AdmissionLimits): Promise<AdmissionState>;
  /** Extend a held slot's lease. */
  renew(ticketId: string, now: number, leaseMs: number): Promise<void>;
  /** Give up the slot or the place in the queue. */
  release(ticketId: string): Promise<void>;
};

/** Per-process store: used in tests. Mirrors `POLL_SCRIPT`. */
export function createMemoryAdmissionStore(): AdmissionStore {
  const queue = new Map<string, number>(); // ticket -> enqueuedAt
  const alive = new Map<string, number>(); // queued ticket -> expiry
  const active = new Map<string, number>(); // ticket -> lease expiry

  return {
    async poll(ticket, now, limits) {
      for (const [id, expiry] of active) if (expiry <= now) active.delete(id);
      for (const [id, expiry] of alive) {
        if (expiry <= now) {
          alive.delete(id);
          queue.delete(id);
        }
      }

      if (active.has(ticket.id)) {
        active.set(ticket.id, now + limits.leaseMs);
        return { state: "granted" };
      }
      if (!queue.has(ticket.id)) {
        if (queue.size >= limits.maxQueue) {
          return { state: "full", queueLength: queue.size };
        }
        queue.set(ticket.id, ticket.enqueuedAt);
      }
      alive.set(ticket.id, now + limits.ticketTtlMs);

      // Same ordering as a sorted set: score, then member.
      const order = [...queue.entries()].sort(
        (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      );
      const rank = order.findIndex(([id]) => id === ticket.id);
      if (rank < limits.maxActive - active.size) {
        queue.delete(ticket.id);
        alive.delete(ticket.id);
        active.set(ticket.id, now + limits.leaseMs);
        return { state: "granted" };
      }
      return { state: "queued", position: rank + 1 };
    },
    async renew(ticketId, now, leaseMs) {
      if (active.has(ticketId)) active.set(ticketId, now + leaseMs);
    },
    async release(ticketId) {
      queue.delete(ticketId);
      alive.delete(ticketId);
      active.delete(ticketId);
    },
  };
}

const KEY_QUEUE = "admission:research:queue";
const KEY_ACTIVE = "admission:research:active";
const KEY_ALIVE = "admission:research:alive";
const ADMISSION_KEYS = [KEY_QUEUE, KEY_ACTIVE, KEY_ALIVE];

/**
 * KEYS: queue (score = arrival time), active (score = lease expiry), alive
 * (score = queued ticket expiry). ARGV: now, ticketId, enqueuedAt, maxActive,
 * maxQueue, leaseMs, ticketTtlMs. Returns {1, 0} granted, {0, position}
 * queued, {-1, queueLength} full.
 */
export const POLL_SCRIPT = `
local now = tonumber(ARGV[1])
local id = ARGV[2]
local enqueuedAt = tonumber(ARGV[3])
local maxActive = tonumber(ARGV[4])
local maxQueue = tonumber(ARGV[5])
local leaseMs = tonumber(ARGV[6])
local ticketTtlMs = tonumber(ARGV[7])

redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local dead = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now)
for _, member in ipairs(dead) do
  redis.call('ZREM', KEYS[1], member)
  redis.call('ZREM', KEYS[3], member)
end

if redis.call('ZSCORE', KEYS[2], id) then
  redis.call('ZADD', KEYS[2], now + leaseMs, id)
  return { 1, 0 }
end
if not redis.call('ZSCORE', KEYS[1], id) then
  local len = redis.call('ZCARD', KEYS[1])
  if len >= maxQueue then
    return { -1, len }
  end
  redis.call('ZADD', KEYS[1], enqueuedAt, id)
end
redis.call('ZADD', KEYS[3], now + ticketTtlMs, id)

local rank = redis.call('ZRANK', KEYS[1], id)
local free = maxActive - redis.call('ZCARD', KEYS[2])
if rank < free then
  redis.call('ZREM', KEYS[1], id)
  redis.call('ZREM', KEYS[3], id)
  redis.call('ZADD', KEYS[2], now + leaseMs, id)
  return { 1, 0 }
end
return { 0, rank + 1 }
`;

/** KEYS: active. ARGV: now, ticketId, leaseMs. */
export const RENEW_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[2]) then
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[3]), ARGV[2])
  return 1
end
return 0
`;

/** KEYS: queue, active, alive. ARGV: ticketId. */
export const RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`;

/** Minimal Redis surface the admission store needs (injectable for tests). */
export type AdmissionScriptDb = {
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
};

export function createRedisAdmissionStore(db: AdmissionScriptDb): AdmissionStore {
  return {
    async poll(ticket, now, limits) {
      const reply = (await db.eval(POLL_SCRIPT, ADMISSION_KEYS, [
        String(now),
        ticket.id,
        String(ticket.enqueuedAt),
        String(limits.maxActive),
        String(limits.maxQueue),
        String(limits.leaseMs),
        String(limits.ticketTtlMs),
      ])) as unknown[];
      const code = Number(reply?.[0]);
      const value = Number(reply?.[1]) || 0;
      if (code === 1) return { state: "granted" };
      if (code === -1) return { state: "full", queueLength: value };
      return { state: "queued", position: Math.max(1, value) };
    },
    async renew(ticketId, now, leaseMs) {
      await db.eval(RENEW_SCRIPT, [KEY_ACTIVE], [String(now), ticketId, String(leaseMs)]);
    },
    async release(ticketId) {
      await db.eval(RELEASE_SCRIPT, ADMISSION_KEYS, [ticketId]);
    },
  };
}

/** A queued turn waited longer than allowed; shown to the user as-is. */
export class AdmissionBusyError extends Error {
  constructor() {
    super(
      "The server is busy with other research requests right now, and this one waited too long in the queue. Please try again in a minute.",
    );
    this.name = "AdmissionBusyError";
  }
}

export type AdmissionQueue = {
  /** False when `maxConcurrentTurns` is 0: every turn runs immediately. */
  enabled: boolean;
  /**
   * Join (or stay in) the queue and take a slot if it is this ticket's turn.
   * Never waits. Fails open (granted) if the store errors.
   */
  poll(ticket: AdmissionTicket): Promise<AdmissionState>;
  /** Keep a granted slot alive; call the returned function to release it. */
  hold(ticket: AdmissionTicket): () => Promise<void>;
  /** Leave the queue (or drop a slot that was never held). */
  cancel(ticket: AdmissionTicket): Promise<void>;
};

type AdmissionConfig = typeof serverConfig.admission;

export function createAdmissionQueue(opts?: {
  store?: AdmissionStore;
  config?: Partial<AdmissionConfig>;
  now?: () => number;
}): AdmissionQueue {
  const config = { ...serverConfig.admission, ...opts?.config };
  const nowFn = opts?.now ?? Date.now;
  const limits: AdmissionLimits = {
    maxActive: config.maxConcurrentTurns,
    maxQueue: config.maxQueueLength,
    leaseMs: config.leaseMs,
    ticketTtlMs: config.ticketTtlMs,
  };
  const resolveStore = (): AdmissionStore =>
    opts?.store ?? createRedisAdmissionStore(redis() as unknown as AdmissionScriptDb);
  const enabled = config.maxConcurrentTurns > 0;

  const poll = async (ticket: AdmissionTicket): Promise<AdmissionState> => {
    if (!enabled) return { state: "granted" };
    try {
      return await resolveStore().poll(ticket, nowFn(), limits);
    } catch (error) {
      // Queueing is an optimisation; never fail a turn because it is down.
      logError("admission-poll", error, { ticket: ticket.id });
      return { state: "granted" };
    }
  };

  const release = async (ticket: AdmissionTicket): Promise<void> => {
    if (!enabled) return;
    try {
      await resolveStore().release(ticket.id);
    } catch (error) {
      logError("admission-release", error, { ticket: ticket.id });
    }
  };

  return {
    enabled,
    poll,
    hold(ticket) {
      if (!enabled) return async () => {};
      const renew = async () => {
        try {
          await resolveStore().renew(ticket.id, nowFn(), limits.leaseMs);
        } catch (error) {
          logError("admission-renew", error, { ticket: ticket.id });
        }
      };
      const timer = setInterval(
        () => void renew(),
        Math.max(1_000, Math.floor(limits.leaseMs / 3)),
      );
      // Never keep an otherwise-finished process alive for a heartbeat.
      (timer as { unref?: () => void }).unref?.();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        await release(ticket);
      };
    },
    cancel: release,
  };
}

let shared: AdmissionQueue | undefined;

/** Process-wide queue backed by Upstash Redis. */
export function sharedAdmissionQueue(): AdmissionQueue {
  shared ??= createAdmissionQueue();
  return shared;
}
