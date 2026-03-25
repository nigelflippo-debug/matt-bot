/**
 * retrieve.js — dual-index retrieval with query enrichment, keyword boost, and reranking
 *
 * Steps:
 *   1. Enrich the query: rewrite current message as a semantic situation description
 *      (conversation history used only to resolve references, not to dominate the query)
 *   2. Keyword search: scan enriched.json for exact term/phrase matches from the raw message
 *   3. Embed the enriched query
 *   4. Search both vector indexes (pair + window)
 *   5. Merge candidates: vector results + keyword-only results not already in vector pool
 *   6. Rerank: vector score + keyword boost + heuristics
 *   7. Return top K
 */

import "dotenv/config";
import OpenAI from "openai";
import { LocalIndex } from "vectra";
import { loadEncryptedJson } from "./crypto-utils.js";
import { getPersona, getSharedPaths } from "../persona/loader.js";

const persona = getPersona();
const shared = getSharedPaths();
const pairIndexPath = persona.paths.indexPair;
const windowIndexPath = persona.paths.indexWindow;
const enrichedEncPath = persona.paths.enrichedEnc;
const enrichedPath    = persona.paths.enrichedJson;
const corpusEncPath   = shared.corpusEnc;
const corpusPath      = shared.corpusJson;

const client = new OpenAI();
const pairIndex = new LocalIndex(pairIndexPath);
const windowIndex = new LocalIndex(windowIndexPath);

// Load all enriched records once at startup for keyword search + ID lookup
const allRecords = loadEncryptedJson(enrichedEncPath, enrichedPath);
const recordById = new Map(allRecords.map((r) => [r.id, r]));

// Load full corpus and group by chat for lore search
const fullCorpus = loadEncryptedJson(corpusEncPath, corpusPath);
const corpusByChat = {};
for (const msg of fullCorpus) {
  if (!corpusByChat[msg.chat]) corpusByChat[msg.chat] = [];
  corpusByChat[msg.chat].push(msg);
}
for (const msgs of Object.values(corpusByChat)) {
  msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// ---------------------------------------------------------------------------
// Fix 1: Query enrichment — anchored to the current message
// ---------------------------------------------------------------------------

const QUERY_ENRICH_SYSTEM = `You convert a chat message into a concise situational description for semantic retrieval.

Your job is to describe what the CURRENT MESSAGE is about. The conversation history is provided only so you can resolve pronouns or references (e.g. what "it" or "that" refers to) — do not let it dominate or replace the description of the current message.

Describe in 1-2 sentences:
- What the current message specifically says or asks
- The social/emotional framing (expressing a preference, venting, joking, asking advice, planning, etc.)

Do NOT describe the conversation history. Do NOT invent information not in the current message. Stay under 40 words.`;

export async function enrichQuery(message, conversationContext = "") {
  const userContent = conversationContext
    ? `CONVERSATION HISTORY:\n${conversationContext}\n\nCURRENT MESSAGE:\n${message}`
    : message;

  const t0 = Date.now();
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: QUERY_ENRICH_SYSTEM },
      { role: "user", content: userContent },
    ],
  });

  const enriched = response.choices[0].message.content.trim();
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "query_enriched", ms: Date.now() - t0, enriched }));
  return enriched;
}

// ---------------------------------------------------------------------------
// Fix 2: Keyword search — handles proper nouns, game names, people, etc.
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "what", "that", "this", "with", "have", "from", "they", "their", "your",
  "when", "then", "than", "some", "more", "will", "been", "were", "would",
  "could", "should", "also", "just", "like", "into", "over", "after",
  "before", "about", "there", "where", "which", "these", "those", "other",
  "such", "even", "well", "back", "still", "here", "very", "much", "many",
  "good", "make", "time", "know", "come", "take", "does", "only", "both",
  "each", "most", "same", "think", "really", "going", "doing", "actually",
  "right", "yeah", "okay", "want", "need", "tell", "know", "remember",
  "ever", "never", "always", "again", "around", "though", "while",
]);

// A word is "meaningful" for search purposes if it's 3+ chars and not a stop word.
// 3 (not 4) so short but specific words like "arc" still anchor bigrams.
const isMeaningful = (w) => w.length >= 3 && !STOP_WORDS.has(w);

/**
 * Extract meaningful search terms from the raw query:
 * - unigrams: words 4+ chars, not stop words
 *             OR proper nouns (start uppercase, 3+ chars) — catches names like "Nic", "Rob", "Tom"
 * - bigrams: two-word phrases where BOTH words are meaningful (3+ chars, non-stop)
 *   This prevents "about ac" matching "about actually", etc.
 */
function extractTerms(query) {
  const originalWords = query.match(/[a-zA-Z']+/g) ?? [];
  const words = originalWords.map((w) => w.toLowerCase());

  // Proper nouns: starts uppercase, 3+ chars, not a stop word
  const properNouns = new Set(
    originalWords
      .filter((w) => w.length >= 3 && /^[A-Z]/.test(w) && !STOP_WORDS.has(w.toLowerCase()))
      .map((w) => w.toLowerCase())
  );

  const unigrams = words.filter((w) => (w.length >= 4 || properNouns.has(w)) && !STOP_WORDS.has(w));
  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    if (isMeaningful(words[i]) && isMeaningful(words[i + 1])) {
      bigrams.push(`${words[i]} ${words[i + 1]}`);
    }
  }
  return { unigrams, bigrams };
}

/**
 * Scan all records for keyword matches.
 * Bigrams score 2x (stronger signal), unigrams score 1x.
 * Returns candidates with a normalized score (0–1).
 */
function keywordSearch(query, topK = 30) {
  const { unigrams, bigrams } = extractTerms(query);
  if (unigrams.length === 0 && bigrams.length === 0) return [];

  const maxPossible = bigrams.length * 2 + unigrams.length;

  const scored = [];
  for (const record of allRecords) {
    const text = `${record.inputContext ?? ""} ${record.response}`.toLowerCase();
    let hits = 0;
    for (const bigram of bigrams) {
      if (text.includes(bigram)) hits += 2;
    }
    for (const unigram of unigrams) {
      if (text.includes(unigram)) hits += 1;
    }
    if (hits > 0) scored.push({ score: hits / maxPossible, metadata: record });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Reranking
// ---------------------------------------------------------------------------

function inferQueryType(message) {
  const lower = message.toLowerCase();
  if (message.trim().endsWith("?")) return "question";
  if (/\b(should|advice|what do you think|help|thoughts)\b/.test(lower)) return "advice";
  if (/\b(tonight|tomorrow|weekend|let's|lets|meet|dinner|game|trip|when)\b/.test(lower))
    return "logistics";
  return null;
}

function detectHumor(message) {
  return /\b(lol|lmao|lmfao|haha|rofl|😂|🤣|💀)\b|!{2,}|\b(bruh|dead)\b/i.test(message);
}

function rerank(candidates, keywordScores, queryType, queryLength, queryHumor) {
  const now = Date.now();
  const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;

  return candidates
    .map((c) => {
      let score = c.score;

      // keyword boost — scaled so a perfect keyword match adds up to 0.2
      const kwScore = keywordScores.get(c.metadata.id) ?? 0;
      score += kwScore * 0.2;

      // response type match
      if (queryType && c.metadata.responseType === queryType) score += 0.08;

      // humor/tone alignment
      if (queryHumor) {
        if (c.metadata.hasHumor) score += 0.04;
        else score -= 0.02;
      }

      // recency
      const age = now - new Date(c.metadata.timestamp).getTime();
      if (age < twoYearsMs) score += 0.04;

      // length alignment
      if (queryLength > 60 && c.metadata.lengthBucket === "short") score -= 0.01;
      if (queryLength > 60 && c.metadata.lengthBucket !== "short") score += 0.01;

      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Lore search — keyword scan over ALL messages to surface shared memories
// ---------------------------------------------------------------------------

/**
 * Search the full corpus (all senders) for conversation windows containing
 * query keywords. Used to ground responses about shared events/memories that
 * the persona may not have written about directly.
 *
 * Scores windows (not individual messages) so that e.g. "brisket" appearing
 * near "steamboat" in the same conversation registers as a strong match.
 *
 * Returns formatted conversation snippets to inject as factual context.
 */
export function loreSearch(query, topK = 3, windowSize = 4, nameVariants = ["matt"]) {
  const { unigrams, bigrams } = extractTerms(query);
  if (unigrams.length === 0 && bigrams.length === 0) return [];

  const maxPossible = bigrams.length * 2 + unigrams.length + 0.5; // +0.5 for persona name mention bonus

  const candidates = [];

  for (const [chat, messages] of Object.entries(corpusByChat)) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.isMedia) continue;

      // Score based on the full window text, not just the individual message
      const start = Math.max(0, i - windowSize);
      const end = Math.min(messages.length - 1, i + windowSize);
      const window = messages.slice(start, end + 1).filter((m) => !m.isMedia);
      const windowText = window.map((m) => m.text).join(" ").toLowerCase();

      let score = 0;
      for (const bigram of bigrams) {
        if (windowText.includes(bigram)) score += 2;
      }
      for (const unigram of unigrams) {
        if (windowText.includes(unigram)) score += 1;
      }
      // Boost windows that explicitly mention the persona
      if (nameVariants.some((n) => windowText.includes(n))) score += 0.5;

      if (score === 0) continue;

      candidates.push({
        score: score / maxPossible,
        chat,
        centerIndex: i,
        timestamp: msg.timestamp,
        lines: window.map((m) => `${m.sender}: ${m.text}`),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // Deduplicate: skip windows whose center is within windowSize*2 of an already-selected one
  const selected = [];
  const selectedByChatIndex = {};

  for (const c of candidates) {
    const prior = selectedByChatIndex[c.chat] ?? [];
    if (prior.some((ci) => Math.abs(ci - c.centerIndex) < windowSize * 2)) continue;

    selected.push({ chat: c.chat, timestamp: c.timestamp, text: c.lines.join("\n") });
    if (!selectedByChatIndex[c.chat]) selectedByChatIndex[c.chat] = [];
    selectedByChatIndex[c.chat].push(c.centerIndex);

    if (selected.length >= topK) break;
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Main retrieval function
// ---------------------------------------------------------------------------

/**
 * @param {string} message - the incoming user message
 * @param {number} k - number of results to return
 * @param {string} conversationContext - recent conversation turns (optional)
 * @returns {Array} top K enriched records
 */
export async function retrieve(message, k = 10, conversationContext = "", excludeIds = new Set()) {
  // Run enrichment and keyword search in parallel
  const [enrichedQuery, keywordResults] = await Promise.all([
    enrichQuery(message, conversationContext),
    Promise.resolve(keywordSearch(message)),
  ]);

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "keyword_search", hits: keywordResults.length }));

  // Embed the enriched query for vector search
  const enrichedEmbResponse = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: [enrichedQuery],
  });
  const queryVector = enrichedEmbResponse.data[0].embedding;

  // Search both vector indexes
  const candidateCount = Math.max(k * 3, 30);
  const t0 = Date.now();
  const [pairResults, windowResults] = await Promise.all([
    pairIndex.queryItems(queryVector, candidateCount),
    windowIndex.queryItems(queryVector, candidateCount),
  ]);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "vector_search", pairHits: pairResults.length, windowHits: windowResults.length, ms: Date.now() - t0 }));

  // Build keyword score map for reranking
  const keywordScores = new Map(
    keywordResults.map((r) => [r.metadata.id, r.score])
  );

  // Merge: vector results first, then keyword-only results not already in pool
  const seen = new Set();
  const merged = [];

  for (const result of [...pairResults, ...windowResults]) {
    const id = result.item.metadata.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const record = recordById.get(id);
    if (record) merged.push({ score: result.score, metadata: record });
  }

  // Add keyword matches that vector search missed entirely
  for (const kw of keywordResults) {
    if (!seen.has(kw.metadata.id)) {
      seen.add(kw.metadata.id);
      merged.push({ score: 0, metadata: kw.metadata }); // base score 0, keyword boost applied in rerank
    }
  }

  // Rerank
  const queryType = inferQueryType(message);
  const queryHumor = detectHumor(message);
  const reranked = rerank(merged, keywordScores, queryType, message.length, queryHumor);

  // Filter out recently used examples — expand pool first to compensate
  const deduplicated = excludeIds.size > 0
    ? reranked.filter((c) => !excludeIds.has(c.metadata.id))
    : reranked;

  // Always keep the top 1 (highest confidence), then randomly sample the rest
  // from the next 19 candidates. Prevents the same examples from being injected
  // every time for similar queries.
  const pool = deduplicated.slice(0, Math.max(k * 3, 20));
  const guaranteed = pool.slice(0, 1);
  const candidates = pool.slice(1);

  // Fisher-Yates shuffle on the candidate pool, take k-1 from it
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  return [...guaranteed, ...candidates.slice(0, Math.max(0, k - 1))].map((r) => r.metadata);
}
