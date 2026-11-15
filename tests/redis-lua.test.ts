import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createMemoryAdmissionStore,
  createRedisAdmissionStore,
  type AdmissionTicket,
} from "@/lib/agent/admission";
import {
  createMemoryBucketStore,
  createRedisBucketStore,
  perMinute,
} from "@/lib/agent/token-bucket";

/**
 * Runs the Lua scripts on a real Redis and checks they behave exactly like
 * the in-memory stores the rest of the suite uses as their model.
 *
 * Opt-in, because it needs a server:
 *
 *   redis-server --port 6391 --save "" &
 *   REDIS_LUA_TEST_PORT=6391 npx vitest run tests/redis-lua.test.ts
 *
 * Use a throwaway local instance only: the test deletes the admission keys.
 */
const PORT = process.env.REDIS_LUA_TEST_PORT;
const CLI = process.env.REDIS_CLI ?? "redis-cli";

function redisCli(...args: string[]): unknown {
  const out = execFileSync(CLI, ["-h", "127.0.0.1", "-p", PORT!, "--json", ...args], {
    encoding: "utf8",
  });
  return JSON.parse(out);
}

const db = {
  eval: async (script: string, keys: string[], args: string[]) =>
    redisCli("EVAL", script, String(keys.length), ...keys, ...args),
};

/** Small deterministic PRNG so a failure can be reproduced from its seed. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe.skipIf(!PORT)("Lua scripts on a real Redis", () => {
  it("token bucket: reserve and clamp match the in-memory model", async () => {
    for (const seed of [1, 2, 3]) {
      const random = prng(seed);
      const pick = (n: number) => Math.floor(random() * n);
      const prefix = `test:bucket:${Date.now()}:${seed}`;
      const buckets = [
        { key: `${prefix}:tpm`, ...perMinute(8_000) },
        { key: `${prefix}:itpm`, ...perMinute(7_000) },
        { key: `${prefix}:otpm`, ...perMinute(1_000) },
      ];
      const memory = createMemoryBucketStore();
      const real = createRedisBucketStore(db);
      let now = 1_700_000_000_000;

      for (let step = 0; step < 150; step++) {
        now += pick(4) === 0 ? pick(30_000) : pick(1_500);
        if (pick(6) === 0) {
          const bucket = buckets[pick(buckets.length)];
          const remaining = pick(bucket.capacity + 500) - 250;
          await memory.clamp(bucket, remaining, now);
          await real.clamp(bucket, remaining, now);
          continue;
        }
        // One, two or all three limits in a single all-or-nothing reservation.
        const specs = buckets.slice(0, 1 + pick(3)).map((bucket) => ({
          ...bucket,
          cost: pick(4_000),
          headroom: pick(3) === 0 ? pick(4_000) : 0,
        }));
        const expected = await memory.reserve(specs, now);
        const actual = await real.reserve(specs, now);
        const context = `seed ${seed}, step ${step}`;
        expect(actual.granted, context).toBe(expected.granted);
        // Redis stores token counts as decimal strings, so allow 1ms of drift.
        expect(Math.abs(actual.waitMs - expected.waitMs), context).toBeLessThanOrEqual(1);
      }
      redisCli("DEL", ...buckets.map((b) => b.key));
    }
  });

  it("token bucket: keys expire once the bucket would be full again", async () => {
    const key = `test:bucket:ttl:${Date.now()}`;
    const real = createRedisBucketStore(db);
    await real.reserve([{ key, cost: 10, ...perMinute(600) }], Date.now());
    const ttlMs = redisCli("PTTL", key) as number;
    expect(ttlMs).toBeGreaterThan(55_000);
    expect(ttlMs).toBeLessThanOrEqual(61_000);
    redisCli("DEL", key);
  });

  it("admission queue: poll, renew and release match the in-memory model", async () => {
    const keys = [
      "admission:research:queue",
      "admission:research:active",
      "admission:research:alive",
    ];
    for (const seed of [11, 12, 13]) {
      redisCli("DEL", ...keys);
      const random = prng(seed);
      const pick = (n: number) => Math.floor(random() * n);
      const limits = { maxActive: 2, maxQueue: 3, leaseMs: 30_000, ticketTtlMs: 20_000 };
      const memory = createMemoryAdmissionStore();
      const real = createRedisAdmissionStore(db);
      const tickets: AdmissionTicket[] = [];
      let now = 1_700_000_000_000;

      for (let step = 0; step < 200; step++) {
        now += pick(5) === 0 ? pick(25_000) : pick(2_000);
        const action = pick(10);
        const context = `seed ${seed}, step ${step}`;
        if (action < 2 || tickets.length === 0) {
          // Distinct arrival times, as in production (ids break exact ties).
          tickets.push({ id: `t${seed}-${step}`, enqueuedAt: now });
        }
        const ticket = tickets[pick(tickets.length)];
        if (action < 7) {
          const expected = await memory.poll(ticket, now, limits);
          const actual = await real.poll(ticket, now, limits);
          expect(actual, context).toEqual(expected);
        } else if (action < 9) {
          await memory.renew(ticket.id, now, limits.leaseMs);
          await real.renew(ticket.id, now, limits.leaseMs);
        } else {
          await memory.release(ticket.id);
          await real.release(ticket.id);
        }
      }
    }
    redisCli("DEL", ...keys);
  });
});
