/**
 * migrate-volume.js — one-time migration of volume memory files into Postgres
 *
 * Discovers all memory.json / lore.json files under a base path, infers
 * persona_id from the directory name, and inserts into the memories table.
 *
 * Usage (inside Railway shell):
 *   node src/rag/migrate-volume.js [base-path]
 *
 * Defaults:
 *   base-path = /app/data/personas
 *
 * Override persona for a specific file:
 *   PERSONA=matt node src/rag/migrate-volume.js /app/data/personas/matt
 *
 * Env vars required: DATABASE_URL, OPENAI_API_KEY
 */

import fs from "fs";
import path from "path";
import pg from "pg";
import OpenAI from "openai";

const { Pool } = pg;
const openai = new OpenAI();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BATCH_SIZE = 10;

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }
if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }

function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

function mapCategory(entry) {
  if (entry.category === "directive") return "directive";
  return "memory";
}

function mapSource(entry) {
  if (entry.source === "url-import" || entry.addedBy === "url-import") return "url-import";
  if (entry.source === "bot-inferred" || entry.addedBy === "extractImplicit") return "bot-inferred";
  return "explicit";
}

/** Find all memory/lore JSON files under basePath */
function findMemoryFiles(basePath) {
  const results = [];
  if (!fs.existsSync(basePath)) {
    console.error(`Path not found: ${basePath}`);
    return results;
  }

  const stat = fs.statSync(basePath);
  if (stat.isFile()) {
    // Single file passed directly
    const personaId = process.env.PERSONA ?? path.basename(path.dirname(basePath));
    results.push({ file: basePath, personaId });
    return results;
  }

  // Directory — walk one level deep looking for memory.json or lore.json
  for (const entry of fs.readdirSync(basePath)) {
    const dir = path.join(basePath, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const personaId = process.env.PERSONA ?? entry;

    for (const name of ["memory.json", "lore.json"]) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) {
        results.push({ file, personaId });
      }
    }
  }

  return results;
}

async function migrateFile(file, personaId) {
  console.log(`\n--- ${file} → persona_id: ${personaId} ---`);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`Failed to parse ${file}: ${err.message}`);
    return;
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    console.log("Empty or invalid file, skipping.");
    return;
  }

  console.log(`${raw.length} entries found`);

  // Fetch existing texts to skip duplicates
  const { rows: existing } = await pool.query(
    `SELECT text FROM memories WHERE persona_id = $1`,
    [personaId]
  );
  const existingTexts = new Set(existing.map((r) => r.text));

  const toInsert = raw.filter((e) => e.text && !existingTexts.has(e.text));
  console.log(`${existingTexts.size} already in Postgres, ${toInsert.length} to insert`);

  if (toInsert.length === 0) return;

  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);

    let embeddings;
    try {
      const res = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: batch.map((e) => e.text),
      });
      embeddings = res.data.map((d) => toVectorLiteral(d.embedding));
    } catch (err) {
      console.error(`\nEmbedding batch failed: ${err.message}`);
      errors += batch.length;
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j];
      const source = mapSource(entry);
      const sourceWeight = source === "url-import" ? 0.8 : source === "bot-inferred" ? 0.6 : 1.0;

      try {
        await pool.query(
          `INSERT INTO memories
             (persona_id, category, text, embedding, person_name, confidence, source, source_weight, source_url, expires_at, added_at)
           VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT DO NOTHING`,
          [
            personaId,
            mapCategory(entry),
            entry.text,
            embeddings[j],
            entry.person ?? null,
            entry.confidence ?? 1.0,
            source,
            sourceWeight,
            entry.sourceUrl ?? null,
            entry.expiresAt ?? null,
            entry.addedAt ?? new Date().toISOString(),
          ]
        );
        inserted++;
      } catch (err) {
        console.error(`\nInsert failed: ${err.message}`);
        errors++;
      }
    }

    process.stdout.write(`\r  ${Math.min(i + BATCH_SIZE, toInsert.length)}/${toInsert.length} processed...`);
  }

  console.log(`\n  Inserted: ${inserted}, Errors: ${errors}`);
}

async function main() {
  const basePath = process.argv[2] ?? "/app/data/personas";
  const files = findMemoryFiles(basePath);

  if (files.length === 0) {
    console.log(`No memory.json or lore.json files found under: ${basePath}`);
    process.exit(0);
  }

  console.log(`Found ${files.length} file(s) to migrate:`);
  files.forEach(({ file, personaId }) => console.log(`  ${file} → ${personaId}`));

  for (const { file, personaId } of files) {
    await migrateFile(file, personaId);
  }

  console.log("\nMigration complete.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
