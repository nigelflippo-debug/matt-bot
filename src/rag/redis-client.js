/**
 * redis-client.js — shared Redis client for cross-bot coordination
 *
 * Used for atomic message claiming so multiple bot instances don't all
 * respond to the same message. Returns null if REDIS_URL is not set,
 * allowing bots to run without Redis (no coordination, no crash).
 */

import Redis from "ioredis";

let client = null;

export function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
    client.on("error", (err) => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "redis_error", message: err.message }));
    });
    client.on("connect", () => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "redis_connected" }));
    });
  }
  return client;
}
