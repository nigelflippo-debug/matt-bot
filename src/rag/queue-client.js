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
let queue = null;

function getQueue() {
  if (queue) return queue;
  if (!process.env.REDIS_URL) return null;
  // BullMQ requires maxRetriesPerRequest: null for blocking queue commands
  const conn = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue(QUEUE_NAME, { connection: conn });
  return queue;
}

/**
 * Publish extracted facts to the inferred memory queue.
 * The worker inserts them into memory_staging and triggers reconciliation.
 *
 * @param {string} personaId
 * @param {Array<{text: string, person: string|null}>} facts
 * @param {string} conversationId
 */
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
