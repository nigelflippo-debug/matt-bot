/**
 * db-client.js — shared Postgres connection pool
 *
 * Used by bots (explicit write/read paths) and the memory-worker.
 * Pool is lazy — created on first call to getPool().
 * Safe to import without DATABASE_URL set; throws only when a query is attempted.
 */

import pg from "pg";

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on("error", (err) => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "db_pool_error", message: err.message }));
  });
  return pool;
}
