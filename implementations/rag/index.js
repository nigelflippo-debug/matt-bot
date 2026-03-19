/**
 * index.js — build two Vectra indexes from enriched.json
 *
 * Index A (index-pair): embeds embeddingText (semantic situation description)
 *   → best for retrieval precision
 *
 * Index B (index-window): embeds windowText (raw conversation window)
 *   → best for conversational style and pacing
 *
 * Run after enrich.js.
 */

import "dotenv/config";
import OpenAI from "openai";
import { LocalIndex } from "vectra";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const enrichedPath = path.resolve(__dirname, "../../data/enriched.json");
const pairIndexPath = path.resolve(__dirname, "../../data/index-pair");
const windowIndexPath = path.resolve(__dirname, "../../data/index-window");

const BATCH_SIZE = 100;
const EMBED_CONCURRENCY = 10;

const client = new OpenAI();

async function buildIndex(indexPath, records, getText, label) {
  console.log(`\nBuilding ${label} index (${records.length} records)...`);

  // Batch embed
  const batches = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    batches.push(records.slice(i, i + BATCH_SIZE));
  }

  console.log(
    `  embedding ${batches.length} batches (${EMBED_CONCURRENCY} concurrent)...`
  );

  const allItems = new Array(records.length);
  let completed = 0;

  for (let i = 0; i < batches.length; i += EMBED_CONCURRENCY) {
    const chunk = batches.slice(i, i + EMBED_CONCURRENCY);

    await Promise.all(
      chunk.map(async (batch, offset) => {
        const batchIndex = i + offset;
        const response = await client.embeddings.create({
          model: "text-embedding-3-small",
          input: batch.map(getText),
        });

        for (let j = 0; j < batch.length; j++) {
          const recordIndex = batchIndex * BATCH_SIZE + j;
          allItems[recordIndex] = {
            vector: response.data[j].embedding,
            metadata: batch[j], // store full record as metadata
          };
        }

        completed += batch.length;
        process.stdout.write(`\r  embedded ${completed} / ${records.length}`);
      })
    );
  }

  // Write index — all insertions in parallel (in-memory within beginUpdate)
  console.log(`\n  writing index to disk...`);
  if (fs.existsSync(indexPath)) {
    fs.rmSync(indexPath, { recursive: true, force: true });
  }

  const index = new LocalIndex(indexPath);
  await index.createIndex();
  await index.beginUpdate();
  await Promise.all(allItems.map((item) => index.insertItem(item)));
  await index.endUpdate();

  console.log(`  done — ${label} index ready at ${indexPath}`);
}

// --- Main ---

if (!fs.existsSync(enrichedPath)) {
  console.error("enriched.json not found. Run enrich.js first.");
  process.exit(1);
}

const records = JSON.parse(fs.readFileSync(enrichedPath, "utf8"));
console.log(`Loaded ${records.length} enriched records`);

// Both indexes are independent — build them in parallel
await Promise.all([
  buildIndex(pairIndexPath, records, (r) => r.embeddingText, "pair"),
  buildIndex(windowIndexPath, records, (r) => r.windowText, "window"),
]);

console.log("\nAll indexes built.");
