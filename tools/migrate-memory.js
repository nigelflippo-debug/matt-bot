/**
 * migrate-memory.js — one-time migration of lore.json into Postgres memories table
 *
 * Usage:
 *   DATABASE_URL=<url> OPENAI_API_KEY=<key> PERSONA=matt node tools/migrate-memory.js [path/to/memory.json]
 *
 * Reads a lore/memory JSON file (default: data/lore.json), embeds each entry,
 * and inserts into the memories table. Skips entries that are already present
 * (matched by text exact equality).
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import OpenAI from "openai";

const { Pool } = pg;
const openai = new OpenAI();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PERSONA_ID = process.env.PERSONA ?? "matt";
const FILE_PATH = process.argv[2] ?? path.resolve(__dirname, "../data/lore.json");
const BATCH_SIZE = 10; // embed N entries at a time

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

function mapCategory(entry) {
  // Old schema used "fact", "directive", "episodic" — map to new categories
  if (entry.category === "directive") return "directive";
  return "memory";
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
  console.log(`Loaded ${raw.length} entries from ${FILE_PATH}`);
  console.log(`Migrating to persona_id: ${PERSONA_ID}`);

  // Fetch existing texts to skip duplicates
  const { rows: existing } = await pool.query(
    `SELECT text FROM memories WHERE persona_id = $1`,
    [PERSONA_ID]
  );
  const existingTexts = new Set(existing.map((r) => r.text));
  console.log(`${existingTexts.size} entries already in Postgres — will skip duplicates`);

  const toInsert = raw.filter((e) => e.text && !existingTexts.has(e.text));
  console.log(`${toInsert.length} entries to insert\n`);

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);

    // Embed the batch
    let embeddings;
    try {
      const res = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: batch.map((e) => e.text),
      });
      embeddings = res.data.map((d) => toVectorLiteral(d.embedding));
    } catch (err) {
      console.error(`Embedding batch ${i}–${i + batch.length - 1} failed: ${err.message}`);
      errors += batch.length;
      continue;
    }

    // Insert each entry
    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j];
      const vector = embeddings[j];
      const category = mapCategory(entry);
      const addedAt = entry.addedAt ?? new Date().toISOString();
      const expiresAt = entry.expiresAt ?? null;
      const personName = entry.person ?? null;
      const source = entry.addedBy === "import-lore" ? "explicit" : (entry.source ?? "explicit");
      const sourceWeight = source === "url-import" ? 0.8 : 1.0;

      try {
        await pool.query(
          `INSERT INTO memories
             (persona_id, category, text, embedding, person_name, confidence, source, source_weight, expires_at, added_at)
           VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING`,
          [PERSONA_ID, category, entry.text, vector, personName, 1.0, source, sourceWeight, expiresAt, addedAt]
        );
        inserted++;
      } catch (err) {
        console.error(`Insert failed for "${entry.text.slice(0, 60)}": ${err.message}`);
        errors++;
      }
    }

    const done = Math.min(i + BATCH_SIZE, toInsert.length);
    process.stdout.write(`\r${done}/${toInsert.length} processed...`);
  }

  console.log(`\n\nDone.`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Skipped (already existed): ${skipped}`);
  console.log(`  Errors: ${errors}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
