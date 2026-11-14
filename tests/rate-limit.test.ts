import { describe, expect, it } from "vitest";
import { checkChatRateLimit, getClientIp, type RateLimitDb } from "@/lib/rate-limit";
import { FakeRedis } from "./fake-redis";

const asDb = (fake: FakeRedis) => fake as unknown as RateLimitDb;
const NOW = 1_700_000_000_000;

describe("getClientIp", () => {
  it("uses the first x-forwarded-for hop", () => {
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(getClientIp(headers)).toBe("1.2.3.4");
  });
  it("falls back to unknown", () => {
    expect(getClientIp(new Headers())).toBe("unknown");
  });
});

describe("checkChatRateLimit", () => {
  it("allows up to the minute limit, then blocks with a retry-after", async () => {
    const fake = new FakeRedis();
    const opts = { perMinute: 3, perHour: 0, now: NOW, db: asDb(fake) };
    for (let i = 0; i < 3; i++) {
      expect((await checkChatRateLimit("9.9.9.9", opts)).allowed).toBe(true);
    }
    const blocked = await checkChatRateLimit("9.9.9.9", opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("tracks IPs independently and enforces the hour window", async () => {
    const fake = new FakeRedis();
    const opts = { perMinute: 0, perHour: 2, now: NOW, db: asDb(fake) };
    expect((await checkChatRateLimit("1.1.1.1", opts)).allowed).toBe(true);
    expect((await checkChatRateLimit("1.1.1.1", opts)).allowed).toBe(true);
    expect((await checkChatRateLimit("1.1.1.1", opts)).allowed).toBe(false);
    expect((await checkChatRateLimit("2.2.2.2", opts)).allowed).toBe(true);
  });

  it("fails open when Redis errors", async () => {
    const db: RateLimitDb = {
      incr: async () => {
        throw new Error("redis down");
      },
      expire: async () => 0,
    };
    const res = await checkChatRateLimit("1.1.1.1", { now: NOW, db });
    expect(res.allowed).toBe(true);
  });

  it("a new window allows requests again", async () => {
    const fake = new FakeRedis();
    const opts = { perMinute: 1, perHour: 0, db: asDb(fake) };
    expect((await checkChatRateLimit("3.3.3.3", { ...opts, now: NOW })).allowed).toBe(true);
    expect((await checkChatRateLimit("3.3.3.3", { ...opts, now: NOW })).allowed).toBe(false);
    expect(
      (await checkChatRateLimit("3.3.3.3", { ...opts, now: NOW + 61_000 })).allowed,
    ).toBe(true);
  });
});
