/**
 * db-migrate.js — run all pending SQL migrations against DATABASE_URL
 *
 * Usage: node src/rag/db-migrate.js
 *
 * Idempotent — all DDL uses IF NOT EXISTS so re-running is safe.
 * Reads every *.sql file in src/rag/migrations/ in filename order.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPool } from "./db-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "migrations");

const files = fs.readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.log("No migration files found.");
  process.exit(0);
}

const pool = getPool();

for (const file of files) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
  console.log(`Running migration: ${file}`);
  await pool.query(sql);
  console.log(`Done: ${file}`);
}

await pool.end();
console.log("All migrations complete.");
