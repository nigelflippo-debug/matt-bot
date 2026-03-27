/**
 * worker.js — memory-worker service
 *
 * Consumes inferred-memory jobs from the BullMQ "memory-inferred" queue.
 * For each job: inserts facts into memory_staging, then triggers reconciliation.
 *
 * Reconciliation is a stub in this feature — full logic added in Feature #6.
 *
 * Required env vars: REDIS_URL, DATABASE_URL
 */

import "dotenv/config";
import Redis from "ioredis";
import { Worker } from "bullmq";
import { getPool } from "../rag/db-client.js";

const QUEUE_NAME = "memory-inferred";

if (!process.env.REDIS_URL) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), stage: "worker_error", message: "REDIS_URL is required" }));
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), stage: "worker_error", message: "DATABASE_URL is required" }));
  process.exit(1);
}

const pool = getPool();

// BullMQ requires maxRetriesPerRequest: null for blocking commands
const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { persona_id, facts, conversation_id } = job.data;

    if (!persona_id || !Array.isArray(facts)) {
      throw new Error("malformed job: missing persona_id or facts array");
    }

    let inserted = 0;
    for (const fact of facts) {
      if (!fact.text) continue;
      try {
        await pool.query(
          `INSERT INTO memory_staging (persona_id, text, person_name, source)
           VALUES ($1, $2, $3, $4)`,
          [persona_id, fact.text, fact.person ?? null, "bot-inferred"]
        );
        inserted++;
      } catch (err) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          stage: "staging_insert_error",
          persona_id,
          error: err.message,
        }));
      }
    }

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      stage: "staging_inserted",
      persona_id,
      conversation_id,
      inserted,
      total: facts.length,
    }));

    // Reconciliation stub — full logic in Feature #6
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      stage: "reconciliation_triggered",
      persona_id,
    }));
  },
  { connection, concurrency: 1 }
);

worker.on("completed", (job) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "job_completed", jobId: job.id }));
});

worker.on("failed", (job, err) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "job_failed", jobId: job?.id, error: err.message }));
});

console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "worker_started", queue: QUEUE_NAME }));

async function shutdown() {
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "worker_shutting_down" }));
  await worker.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
