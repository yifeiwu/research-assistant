import "server-only";
import { Redis } from "@upstash/redis";

let client: Redis | undefined;

/**
 * Lazy Upstash Redis singleton initialized from `UPSTASH_REDIS_REST_URL` and
 * `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` / `KV_REST_API_TOKEN`).
 * Deferred until first call so `next build` can import server routes without
 * requiring runtime credentials at build time.
 */
export function redis(): Redis {
  client ??= Redis.fromEnv();
  return client;
}
