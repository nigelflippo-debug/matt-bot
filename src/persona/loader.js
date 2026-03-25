/**
 * loader.js — load persona configuration
 *
 * Reads persona config from personas/<id>/config.json.
 * Persona ID is set via the PERSONA env var (default: "matt").
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const isProduction = process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT;

/**
 * Resolve data paths for a persona. In production, uses /app/data/personas/<id>/;
 * locally, uses <projectRoot>/data/personas/<id>/.
 */
function resolveDataPaths(personaId) {
  const base = isProduction
    ? `/app/data/personas/${personaId}`
    : path.resolve(projectRoot, `data/personas/${personaId}`);
  const srcBase = isProduction
    ? `/app/data-src/personas/${personaId}`
    : null;

  return {
    dataDir: base,
    srcDir: srcBase,
    enrichedEnc: path.join(base, "enriched.enc"),
    enrichedJson: path.join(base, "enriched.json"),
    loreJson: path.join(base, "lore.json"),
    discordPairsJson: path.join(base, "discord-pairs.json"),
    indexPair: path.join(base, "index-pair"),
    indexWindow: path.join(base, "index-window"),
    indexLore: path.join(base, "index-lore"),
    indexDiscord: path.join(base, "index-discord"),
    // Seed paths for production deployment (copied from image to persistent volume)
    seedEnrichedEnc: srcBase ? path.join(srcBase, "enriched.enc") : null,
    seedLoreEnc: srcBase ? path.join(srcBase, "lore.enc") : null,
    seedLoreJson: srcBase ? path.join(srcBase, "lore.json") : null,
  };
}

/**
 * Resolve shared (non-persona) data paths. Corpus is shared across personas.
 */
function resolveSharedPaths() {
  const base = isProduction ? "/app/data" : path.resolve(projectRoot, "data");
  const srcBase = isProduction ? "/app/data-src" : null;

  return {
    dataDir: base,
    corpusEnc: path.join(base, "corpus.enc"),
    corpusJson: path.join(base, "corpus.json"),
    seedCorpusEnc: srcBase ? path.join(srcBase, "corpus.enc") : null,
  };
}

function loadPersonaConfig(personaId) {
  // In production, persona configs are at /app/personas/<id>/config.json
  // Locally, at <projectRoot>/personas/<id>/config.json
  const personaDir = isProduction
    ? `/app/personas/${personaId}`
    : path.resolve(projectRoot, `personas/${personaId}`);
  const configPath = path.join(personaDir, "config.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(`Persona config not found: ${configPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));

  return {
    id: raw.id,
    name: raw.name,
    senderNames: raw.senderNames,
    nameVariants: raw.nameVariants,
    discordUserId: raw.discordUserIdEnv ? (process.env[raw.discordUserIdEnv] ?? "") : "",
    homeChannel: raw.homeChannel,
    specialBehaviors: raw.specialBehaviors ?? {},
    memoryPhrases: raw.memoryPhrases ?? null,
    paths: resolveDataPaths(raw.id),
    systemPromptEnc: path.join(personaDir, "system-prompt.enc"),
    systemPromptMd: path.join(personaDir, "system-prompt.md"),
  };
}

const personaId = process.env.PERSONA ?? "matt";
const activePersona = loadPersonaConfig(personaId);
const sharedPaths = resolveSharedPaths();

console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "persona_loaded", persona: activePersona.id, name: activePersona.name }));

export function getPersona() {
  return activePersona;
}

export function getSharedPaths() {
  return sharedPaths;
}
