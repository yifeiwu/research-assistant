import "server-only";
import { redis } from "./redis";
import { serverConfig } from "./config";
import { logError, logInfo } from "./logger";

/** Minimal Redis surface the limiter needs (injectable for tests). */
export type RateLimitDb = {
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<unknown>;
};

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

/**
 * Best-effort client IP for rate limiting. Behind Vercel the first
 * `x-forwarded-for` hop is the client; fall back to platform headers, and
 * finally to a shared "unknown" bucket (better than no limit at all).
 */
export function getClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    headers.get("x-real-ip") ??
    headers.get("cf-connecting-ip") ??
    "unknown"
  );
}

async function checkWindow(
  db: RateLimitDb,
  key: string,
  windowSeconds: number,
  now: number,
): Promise<{ count: number; retryAfterSeconds: number }> {
  const count = await db.incr(key);
  if (count === 1) {
    await db.expire(key, windowSeconds);
  }
  const retryAfterSeconds = Math.max(
    1,
    windowSeconds - Math.floor((now % (windowSeconds * 1000)) / 1000),
  );
  return { count, retryAfterSeconds };
}

/**
 * Per-IP fixed-window rate limit for chat generation (minute + hour), backed
 * by Redis so limits hold across serverless instances.
 *
 * Fails open: if Redis is unavailable the request is allowed (and the error
 * logged), because Redis is already a hard dependency of the resumable
 * stream path for identified chats — a limiter outage shouldn't take down
 * local/dev usage without Redis. A limit of 0 disables that window.
 */
export async function checkChatRateLimit(
  ip: string,
  opts?: {
    perMinute?: number;
    perHour?: number;
    now?: number;
    db?: RateLimitDb;
  },
): Promise<RateLimitResult> {
  const perMinute = opts?.perMinute ?? serverConfig.rateLimit.perMinute;
  const perHour = opts?.perHour ?? serverConfig.rateLimit.perHour;
  const now = opts?.now ?? Date.now();

  let db: RateLimitDb;
  try {
    db = opts?.db ?? (redis() as RateLimitDb);
  } catch (error) {
    logError("rate-limit-redis", error, { ip });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  try {
    let retryAfter = 0;
    if (perMinute > 0) {
      const minuteBucket = Math.floor(now / 60_000);
      const { count, retryAfterSeconds } = await checkWindow(
        db,
        `ratelimit:chat:min:${ip}:${minuteBucket}`,
        60,
        now,
      );
      if (count > perMinute) retryAfter = Math.max(retryAfter, retryAfterSeconds);
    }
    if (perHour > 0) {
      const hourBucket = Math.floor(now / 3_600_000);
      const { count, retryAfterSeconds } = await checkWindow(
        db,
        `ratelimit:chat:hour:${ip}:${hourBucket}`,
        3_600,
        now,
      );
      if (count > perHour) retryAfter = Math.max(retryAfter, retryAfterSeconds);
    }
    if (retryAfter > 0) {
      logInfo("rate-limited", { ip, retryAfterSeconds: retryAfter });
      return { allowed: false, retryAfterSeconds: retryAfter };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    logError("rate-limit-redis", error, { ip });
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
