/**
 * queue-client.js — publish inferred memory jobs to the BullMQ queue
 *
 * Used by the bot after extractImplicit() to hand off facts to the
 * memory-worker for async staging + reconciliation.
 *
 * No-op if REDIS_URL is not set (allows bots to run without a worker).
 */

import Redis from "ioredis";
import { Queue } from "bullmq";

const QUEUE_NAME = "memory-inferred";
const ENTITY_QUEUE_NAME = "entity-maintenance";
let queue = null;
let entityQueue = null;

function getQueue() {
  if (queue) return queue;
  if (!process.env.REDIS_URL) return null;
  // BullMQ requires maxRetriesPerRequest: null for blocking queue commands
  const conn = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue(QUEUE_NAME, { connection: conn });
  return queue;
}

function getEntityQueue() {
  if (entityQueue) return entityQueue;
  if (!process.env.REDIS_URL) return null;
  const conn = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  entityQueue = new Queue(ENTITY_QUEUE_NAME, { connection: conn });
  return entityQueue;
}

/**
 * Publish extracted facts to the inferred memory queue.
 * The worker inserts them into memory_staging and triggers reconciliation.
 *
 * @param {string} personaId
 * @param {Array<{text: string, person: string|null}>} facts
 * @param {string} conversationId
 */
/**
 * Enqueue a backfill job to rebuild entity summaries with no summary yet.
 * Runs in the worker via the entity-maintenance queue.
 */
export async function publishEntityBackfill(personaId) {
  const q = getEntityQueue();
  if (!q) return;
  await q.add("rebuild-entities", { type: "rebuild-entities", persona_id: personaId });
}

export async function publishInferredMemory(personaId, facts, conversationId) {
  const q = getQueue();
  if (!q) return;
  await q.add(
    "inferred",
    {
      persona_id: personaId,
      facts,
      conversation_id: conversationId,
      added_at: new Date().toISOString(),
    },
    { attempts: 2, backoff: { type: "exponential", delay: 5000 } }
  );
}
