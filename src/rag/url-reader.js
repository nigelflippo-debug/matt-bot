/**
 * url-reader.js — fetch a URL, extract text, chunk, and extract facts via LLM
 */

import { parse } from "node-html-parser";
import OpenAI from "openai";

const openai = new OpenAI();

function log(stage, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: "url-reader", stage, ...data }));
}

const MAX_HTML_BYTES = 500_000; // 500KB
const CHUNK_SIZE = 2000; // chars per chunk
const MAX_FACTS = 50;
const FETCH_TIMEOUT_MS = 10_000;

const EXTRACT_PROMPT = `You extract discrete, specific facts from web content. Return a JSON object with a "facts" array of strings.

Rules:
- Each fact should be a single, self-contained statement
- Focus on factual claims, stats, game mechanics, lore, characters, events — anything worth remembering
- Skip navigation text, disclaimers, generic filler, "see also" references, and formatting artifacts
- Keep facts concise but complete enough to understand without context
- If the content is about a game, character, or topic, include the subject name in each fact so it stands alone
- Return {"facts": []} if there's nothing worth extracting`;

/**
 * Fetch a URL and return the HTML body as a string.
 * Throws on timeout, non-HTML content, or oversized response.
 */
async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MattBot/1.0)" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      throw new Error("not-html");
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_HTML_BYTES) {
      throw new Error("too-large");
    }

    log("fetch_ok", { url, bytes: buffer.byteLength, contentType });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract meaningful text from HTML, preserving structure from wiki-style content.
 */
function extractText(html) {
  const root = parse(html);

  // Remove script, style, nav, footer, sidebar elements
  for (const tag of ["script", "style", "nav", "footer", "aside", "noscript", "header"]) {
    root.querySelectorAll(tag).forEach((el) => el.remove());
  }
  // Remove common wiki noise classes
  for (const cls of ["navbox", "sidebar", "mw-editsection", "reference", "reflist", "toc", "catlinks", "mw-jump-link"]) {
    root.querySelectorAll(`.${cls}`).forEach((el) => el.remove());
  }

  const blocks = [];
  const seen = new Set();

  for (const el of root.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, td, th, dd, dt, blockquote, figcaption")) {
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (text.length < 5) continue;
    if (seen.has(text)) continue;
    seen.add(text);

    const tag = el.tagName?.toLowerCase() ?? "";
    if (tag.startsWith("h")) {
      blocks.push(`\n## ${text}\n`);
    } else {
      blocks.push(text);
    }
  }

  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Split text into chunks of roughly CHUNK_SIZE chars, respecting paragraph boundaries.
 */
function chunkText(text) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > CHUNK_SIZE && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += (current ? "\n\n" : "") + para;
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

/**
 * Extract facts from a single text chunk via LLM.
 */
async function extractFactsFromChunk(chunk) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACT_PROMPT },
        { role: "user", content: chunk },
      ],
    });
    const result = JSON.parse(response.choices[0].message.content);
    if (!Array.isArray(result.facts)) return [];
    return result.facts.filter((f) => typeof f === "string" && f.length > 0);
  } catch (err) {
    log("chunk_extract_error", { message: err.message, chunkPreview: chunk.slice(0, 100) });
    return [];
  }
}

/**
 * Main entry point: fetch URL → extract text → chunk → extract facts.
 *
 * Returns { facts: string[], pageTitle: string, error?: string }
 */
export async function readUrl(url) {
  let html;
  try {
    html = await fetchPage(url);
  } catch (err) {
    const error = err.name === "AbortError" ? "timeout" : err.message === "not-html" ? "not-html" : err.message === "too-large" ? "too-large" : "fetch-failed";
    log("fetch_error", { url, error, message: err.message });
    return { facts: [], pageTitle: "", error };
  }

  // Grab title for display
  const root = parse(html);
  const pageTitle = root.querySelector("title")?.textContent?.trim() ?? url;

  const text = extractText(html);
  log("text_extracted", { url, pageTitle, textLength: text.length, preview: text.slice(0, 200) });

  if (text.length < 20) {
    log("no_content", { url, pageTitle, textLength: text.length });
    return { facts: [], pageTitle, error: "no-content" };
  }

  const chunks = chunkText(text);
  log("chunked", { url, chunkCount: chunks.length, chunkSizes: chunks.map((c) => c.length) });

  const allFacts = [];

  for (let i = 0; i < chunks.length; i++) {
    if (allFacts.length >= MAX_FACTS) {
      log("max_facts_reached", { url, capped: MAX_FACTS, chunksProcessed: i, totalChunks: chunks.length });
      break;
    }
    const facts = await extractFactsFromChunk(chunks[i]);
    log("chunk_extracted", { url, chunk: i + 1, totalChunks: chunks.length, factsFound: facts.length, facts: facts.map((f) => f.slice(0, 80)) });
    allFacts.push(...facts);
  }

  log("extraction_complete", { url, pageTitle, totalFacts: Math.min(allFacts.length, MAX_FACTS) });

  return {
    facts: allFacts.slice(0, MAX_FACTS),
    pageTitle,
  };
}
