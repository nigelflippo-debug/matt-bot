/**
 * pipeline.js — enrich + index in one pipelined pass
 *
 * Replaces running enrich.js then index.js separately.
 *
 * Enrichment (LLM) and embedding (OpenAI) run concurrently:
 *   - as each enrichment batch finishes, embedding starts immediately on those records
 *   - no waiting for all enrichment to complete before embedding begins
 *
 * Uses a semaphore-based rolling window instead of chunk-based concurrency,
 * so a new task starts as soon as any slot frees — no waiting for slow stragglers.
 *
 * At the end:
 *   - both Vectra indexes are built in parallel with bulk parallel insertions
 *   - enriched.json is written for reference / reuse
 */

import "dotenv/config";
import OpenAI from "openai";
import { LocalIndex } from "vectra";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.resolve(__dirname, "../data/corpus.json");
const enrichedPath = path.resolve(__dirname, "../data/enriched.json");
const pairIndexPath = path.resolve(__dirname, "../data/index-pair");
const windowIndexPath = path.resolve(__dirname, "../data/index-window");

const ENRICH_BATCH = 20;   // records per LLM enrichment call
const EMBED_BATCH = 20;    // records per embedding call (matches enrich batch for pipelining)
const LLM_CONCURRENCY = 10;
const EMBED_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Semaphore — rolling window concurrency (better than chunk-based)
// ---------------------------------------------------------------------------

class Semaphore {
  constructor(n) {
    this._slots = n;
    this._waiting = [];
  }
  acquire() {
    if (this._slots > 0) {
      this._slots--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._waiting.push(resolve));
  }
  release() {
    if (this._waiting.length > 0) {
      this._waiting.shift()();
    } else {
      this._slots++;
    }
  }
}

async function withLimit(sem, fn) {
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
}

// ---------------------------------------------------------------------------
// Corpus loading and raw record building (same logic as enrich.js)
// ---------------------------------------------------------------------------

const JUNK_RE =
  /^(lol\.?|lmao\.?|lmfao\.?|haha+\.?|😂+|🤣+|💀+|ok|okay|k|fr\.?|true|nice|yep|yup|nope|damn\.?|wow\.?|👍+|🙏+|smh|rip|oof|bruh|yikes|facts|cap|based|real)$/i;

function groupIntoTurns(messages) {
  const turns = [];
  for (const msg of messages) {
    if (turns.length > 0 && turns[turns.length - 1].sender === msg.sender) {
      turns[turns.length - 1].lines.push(msg.text);
    } else {
      turns.push({ sender: msg.sender, lines: [msg.text] });
    }
  }
  return turns;
}

function turnToText(t) {
  return `${t.sender}: ${t.lines.join(" / ")}`;
}

function inferLengthBucket(text) {
  if (text.length < 50) return "short";
  if (text.length < 150) return "medium";
  return "long";
}

function inferResponseType(text) {
  const lower = text.toLowerCase();
  if (text.trim().endsWith("?")) return "question";
  if (/\b(should(n't)?|don't|do |just |try |definitely|have to|need to|gotta|make sure)\b/.test(lower)) return "advice";
  if (/\b(when|tonight|tomorrow|weekend|let's|lets|coming|going|meet|time|schedule|dinner|game|trip)\b/.test(lower)) return "logistics";
  if (/\b(honestly|ngl|tbh|imo|i think|i feel|i believe)\b/.test(lower)) return "opinion";
  if (text.length < 80 && /\b(haha|lol|lmao|damn|nice|yep|yeah|nah|bro|dude|omg)\b/.test(lower)) return "reaction";
  return "statement";
}

function inferHasHumor(text) {
  return /haha|lol|lmao|🤣|😂|!{2,}|lmfao/i.test(text);
}

function isJunk(mattText, contextTurns) {
  const t = mattText.trim();
  if (JUNK_RE.test(t)) return contextTurns.length < 2;
  if (t.length <= 6 && contextTurns.length === 0) return true;
  return false;
}

function buildRawRecords(corpus) {
  const byChat = {};
  for (const msg of corpus) {
    if (!byChat[msg.chat]) byChat[msg.chat] = [];
    byChat[msg.chat].push(msg);
  }
  for (const msgs of Object.values(byChat)) {
    msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  const records = [];
  let skipped = 0;

  for (const [chat, messages] of Object.entries(byChat)) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.isMatt || msg.isMedia) continue;

      const lookback = messages.slice(Math.max(0, i - 20), i).filter((m) => !m.isMedia);
      const allTurns = groupIntoTurns(lookback);
      const nonMattTurns = allTurns.filter((t) => t.sender !== "Matt Guiod");
      const contextTurns = nonMattTurns.slice(-3);

      if (isJunk(msg.text, contextTurns)) { skipped++; continue; }

      const inputContext = contextTurns.map(turnToText).join("\n");
      const response = `Matt: ${msg.text}`;
      const following = messages.slice(i + 1, i + 3).filter((m) => !m.isMedia);
      const windowText = [
        ...allTurns.slice(-3).map(turnToText),
        response,
        ...following.map((m) => `${m.sender}: ${m.text}`),
      ].join("\n");

      records.push({
        id: `${chat}_${i}`,
        inputContext,
        response,
        windowText,
        responseType: inferResponseType(msg.text),
        hasHumor: inferHasHumor(msg.text),
        lengthBucket: inferLengthBucket(msg.text),
        timestamp: msg.timestamp,
        chat,
      });
    }
  }

  return { records, skipped };
}

// ---------------------------------------------------------------------------
// Enrichment (LLM → embeddingText)
// ---------------------------------------------------------------------------

const client = new OpenAI();

const ENRICH_SYSTEM = `You write concise semantic descriptions of conversational situations for use in semantic search/retrieval.

For each item you receive, write 1-2 sentences describing:
- What topic or situation is being discussed
- The emotional or social context (venting, asking advice, joking, planning, debating, reacting to news, etc.)
- What the speaker is responding to

Rules:
- Do NOT mention "Matt" by name
- Do NOT quote the messages
- Be specific about situation type, not just topic
- Stay under 50 words per description

Return JSON: {"results": [{"i": 0, "d": "..."}, {"i": 1, "d": "..."}, ...]}`;

async function enrichBatch(records, attempt = 0) {
  const items = records.map((r, i) => ({
    i,
    ctx: r.inputContext || "(no prior context)",
    reply: r.response,
  }));

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.3,
      messages: [
        { role: "system", content: ENRICH_SYSTEM },
        { role: "user", content: JSON.stringify(items) },
      ],
    });
    const parsed = JSON.parse(resp.choices[0].message.content);
    const map = {};
    for (const r of parsed.results ?? []) map[r.i] = r.d;
    return records.map((r, i) => ({
      ...r,
      embeddingText: map[i] || (r.inputContext ? `${r.inputContext}\n${r.response}` : r.response),
    }));
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return enrichBatch(records, attempt + 1);
    }
    console.error(`\nEnrichment batch failed: ${err.message} — using fallback`);
    return records.map((r) => ({
      ...r,
      embeddingText: r.inputContext ? `${r.inputContext}\n${r.response}` : r.response,
    }));
  }
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

async function embedBatch(records, attempt = 0) {
  try {
    const resp = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: records.map((r) => r.embeddingText),
    });
    return records.map((r, i) => ({
      pairItem: { vector: resp.data[i].embedding, metadata: r },
    }));
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return embedBatch(records, attempt + 1);
    }
    throw err;
  }
}

async function embedWindowBatch(records, attempt = 0) {
  try {
    const resp = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: records.map((r) => r.windowText),
    });
    return records.map((r, i) => ({
      windowItem: { vector: resp.data[i].embedding, metadata: r },
    }));
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return embedWindowBatch(records, attempt + 1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

console.log("Loading corpus...");
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
const { records: rawRecords, skipped } = buildRawRecords(corpus);
console.log(`Built ${rawRecords.length} records (skipped ${skipped} junk)`);

// Split into enrichment batches
const enrichBatches = [];
for (let i = 0; i < rawRecords.length; i += ENRICH_BATCH) {
  enrichBatches.push(rawRecords.slice(i, i + ENRICH_BATCH));
}

const llmSem = new Semaphore(LLM_CONCURRENCY);
const embedSem = new Semaphore(EMBED_CONCURRENCY);

const allPairItems = [];
const allWindowItems = [];
const allEnrichedRecords = [];

let enrichedCount = 0;
let embeddedCount = 0;
const total = rawRecords.length;

// Launch all enrichment tasks using the rolling semaphore.
// Each enrichment task, on completion, immediately launches two embedding tasks
// (one for pair index, one for window index) — also semaphore-gated.
const tasks = enrichBatches.map((batch) =>
  withLimit(llmSem, async () => {
    const enriched = await enrichBatch(batch);
    enrichedCount += enriched.length;
    process.stdout.write(
      `\r  enriched ${enrichedCount}/${total}  embedded ${embeddedCount}/${total}`
    );

    allEnrichedRecords.push(...enriched);

    // Fire both embedding calls for this batch concurrently
    await Promise.all([
      withLimit(embedSem, async () => {
        const items = await embedBatch(enriched);
        for (const { pairItem } of items) allPairItems.push(pairItem);
        embeddedCount += enriched.length;
        process.stdout.write(
          `\r  enriched ${enrichedCount}/${total}  embedded ${embeddedCount}/${total}`
        );
      }),
      withLimit(embedSem, async () => {
        const items = await embedWindowBatch(enriched);
        for (const { windowItem } of items) allWindowItems.push(windowItem);
      }),
    ]);
  })
);

console.log(
  `\nPipelining enrichment (${LLM_CONCURRENCY} concurrent) + embedding (${EMBED_CONCURRENCY} concurrent)...`
);
await Promise.all(tasks);
console.log(`\nAll records enriched and embedded.`);

// ---------------------------------------------------------------------------
// Write enriched.json and build both Vectra indexes — all in parallel
// ---------------------------------------------------------------------------

async function writeIndex(indexPath, items, label) {
  if (fs.existsSync(indexPath)) fs.rmSync(indexPath, { recursive: true, force: true });
  const index = new LocalIndex(indexPath);
  await index.createIndex();
  await index.beginUpdate();
  await Promise.all(items.map((item) => index.insertItem(item)));
  await index.endUpdate();
  console.log(`  ${label} index written (${items.length} items)`);
}

console.log("Writing enriched.json and building indexes in parallel...");
await Promise.all([
  fs.promises.writeFile(enrichedPath, JSON.stringify(allEnrichedRecords, null, 2)),
  writeIndex(pairIndexPath, allPairItems, "pair"),
  writeIndex(windowIndexPath, allWindowItems, "window"),
]);

console.log("Done.");
