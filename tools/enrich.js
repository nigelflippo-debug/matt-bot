/**
 * enrich.js — build context-response pairs from corpus.json
 *
 * For each Matt message:
 *   - groups preceding messages into speaker turns
 *   - takes last N non-Matt turns as input context
 *   - builds window_text (context + reply + following msgs)
 *   - infers heuristic metadata (response_type, length_bucket, etc.)
 *   - filters junk replies
 *   - generates embedding_text via gpt-4o-mini (semantic situation description)
 *
 * Output: data/enriched.json
 */

import "dotenv/config";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.resolve(__dirname, "../data/corpus.json");
const enrichedPath = path.resolve(__dirname, "../data/enriched.json");

const CONTEXT_TURNS = 3;   // max preceding speaker-turns (non-Matt) to include
const WINDOW_AFTER = 2;    // following messages to include in window_text
const BATCH_SIZE = 20;      // records per LLM enrichment call
const LLM_CONCURRENCY = 10; // parallel LLM calls

const JUNK_RE =
  /^(lol\.?|lmao\.?|lmfao\.?|haha+\.?|😂+|🤣+|💀+|ok|okay|k|fr\.?|true|nice|yep|yup|nope|damn\.?|wow\.?|👍+|🙏+|smh|rip|oof|bruh|yikes|facts|cap|based|real)$/i;

// --- Turn grouping ---

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

function turnToText(turn) {
  return `${turn.sender}: ${turn.lines.join(" / ")}`;
}

// --- Metadata heuristics ---

function inferLengthBucket(text) {
  if (text.length < 50) return "short";
  if (text.length < 150) return "medium";
  return "long";
}

function inferResponseType(text) {
  const lower = text.toLowerCase();
  if (text.trim().endsWith("?")) return "question";
  if (/\b(should(n't)?|don't|do |just |try |definitely|have to|need to|gotta|make sure)\b/.test(lower))
    return "advice";
  if (/\b(when|tonight|tomorrow|weekend|let's|lets|coming|going|meet|time|schedule|dinner|game|trip)\b/.test(lower))
    return "logistics";
  if (/\b(honestly|ngl|tbh|imo|i think|i feel|i believe)\b/.test(lower))
    return "opinion";
  if (text.length < 80 && /\b(haha|lol|lmao|damn|nice|yep|yeah|nah|bro|dude|omg)\b/.test(lower))
    return "reaction";
  return "statement";
}

function inferHasHumor(text) {
  return /haha|lol|lmao|🤣|😂|!{2,}|lmfao/i.test(text);
}

function isJunk(mattText, contextTurns) {
  const t = mattText.trim();
  // always drop emoji-only or pure junk pattern if context is weak
  if (JUNK_RE.test(t)) {
    return contextTurns.length < 2;
  }
  // drop very short messages (1-2 words) that are standalone reactions with no context
  if (t.length <= 6 && contextTurns.length === 0) {
    return true;
  }
  return false;
}

// --- Build raw records ---

const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));

const byChat = {};
for (const msg of corpus) {
  if (!byChat[msg.chat]) byChat[msg.chat] = [];
  byChat[msg.chat].push(msg);
}
for (const msgs of Object.values(byChat)) {
  msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

const rawRecords = [];
let skipped = 0;

for (const [chat, messages] of Object.entries(byChat)) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.isMatt || msg.isMedia) continue;

    // lookback window: up to 20 preceding messages, no media
    const lookback = messages
      .slice(Math.max(0, i - 20), i)
      .filter((m) => !m.isMedia);

    // group into speaker turns, take last CONTEXT_TURNS non-Matt turns
    const allTurns = groupIntoTurns(lookback);
    const nonMattTurns = allTurns.filter((t) => t.sender !== "Matt Guiod");
    const contextTurns = nonMattTurns.slice(-CONTEXT_TURNS);

    if (isJunk(msg.text, contextTurns)) {
      skipped++;
      continue;
    }

    const inputContext = contextTurns.map(turnToText).join("\n");
    const response = `Matt: ${msg.text}`;

    // window_text: full turns (all speakers) + reply + WINDOW_AFTER following msgs
    const allContextTurns = allTurns.slice(-CONTEXT_TURNS);
    const following = messages
      .slice(i + 1, i + 1 + WINDOW_AFTER)
      .filter((m) => !m.isMedia);
    const windowText = [
      ...allContextTurns.map(turnToText),
      response,
      ...following.map((m) => `${m.sender}: ${m.text}`),
    ].join("\n");

    rawRecords.push({
      id: `${chat}_${i}`,
      inputContext,
      response,
      windowText,
      responseType: inferResponseType(msg.text),
      hasHumor: inferHasHumor(msg.text),
      lengthBucket: inferLengthBucket(msg.text),
      timestamp: msg.timestamp,
      chat,
      // embeddingText filled in next step
    });
  }
}

console.log(`Built ${rawRecords.length} records (skipped ${skipped} junk)`);

// --- Generate embedding_text via LLM ---

const client = new OpenAI();

const SYSTEM = `You write concise semantic descriptions of conversational situations for use in semantic search/retrieval.

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
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify(items) },
      ],
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    const map = {};
    for (const r of parsed.results ?? []) map[r.i] = r.d;
    return records.map((_, i) => map[i] ?? "");
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return enrichBatch(records, attempt + 1);
    }
    console.error(`Batch failed after retries: ${err.message}`);
    // fallback: use raw context as embedding text
    return records.map((r) =>
      r.inputContext ? `${r.inputContext}\n${r.response}` : r.response
    );
  }
}

const batches = [];
for (let i = 0; i < rawRecords.length; i += BATCH_SIZE) {
  batches.push(rawRecords.slice(i, i + BATCH_SIZE));
}

console.log(
  `Enriching ${rawRecords.length} records in ${batches.length} batches (${LLM_CONCURRENCY} concurrent)...`
);

const enrichedRecords = new Array(rawRecords.length);
let completedCount = 0;

for (let i = 0; i < batches.length; i += LLM_CONCURRENCY) {
  const chunk = batches.slice(i, i + LLM_CONCURRENCY);

  await Promise.all(
    chunk.map(async (batch, offset) => {
      const batchIndex = i + offset;
      const descriptions = await enrichBatch(batch);

      for (let j = 0; j < batch.length; j++) {
        const recordIndex = batchIndex * BATCH_SIZE + j;
        enrichedRecords[recordIndex] = {
          ...batch[j],
          embeddingText:
            descriptions[j] ||
            (batch[j].inputContext
              ? `${batch[j].inputContext}\n${batch[j].response}`
              : batch[j].response),
        };
      }

      completedCount += batch.length;
      process.stdout.write(`\r  enriched ${completedCount} / ${rawRecords.length}`);
    })
  );
}

console.log("\nWriting enriched.json...");
fs.writeFileSync(enrichedPath, JSON.stringify(enrichedRecords, null, 2));
console.log(`Done. ${enrichedRecords.length} records written to data/enriched.json`);
