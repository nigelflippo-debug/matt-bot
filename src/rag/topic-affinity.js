/**
 * topic-affinity.js — derive topic keywords from a persona's system prompt
 * and score incoming messages against them to inform claim delay.
 *
 * initAffinity() is called once at startup. scoreMessage() + getDelayMs()
 * are called per-message in the Redis coordination path.
 */

import OpenAI from "openai";

const client = new OpenAI();

let keywords = []; // populated by initAffinity()
let ready = false;

/**
 * Extract topic keywords from the persona's system prompt via gpt-4o-mini.
 * One-time call at startup; result cached for the process lifetime.
 */
export async function initAffinity(systemPromptText) {
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "You extract topic keywords from a persona description. Return only a JSON array of lowercase strings — topics, interests, and subject areas this persona cares about or is associated with. 20–40 keywords. No explanation.",
        },
        {
          role: "user",
          content: systemPromptText,
        },
      ],
    });

    const raw = response.choices[0].message.content.trim();
    // Strip markdown code fences if present
    const json = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(json);

    if (Array.isArray(parsed) && parsed.length > 0) {
      keywords = parsed.map((k) => k.toLowerCase());
      ready = true;
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "affinity_init", keywords: keywords.length }));
    }
  } catch (err) {
    // Non-fatal — fall back to no delay (random claiming)
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "affinity_init_error", message: err.message }));
  }
}

/**
 * Score a message against this persona's topic keywords.
 * Returns 0–1: proportion of keywords that appear in the message.
 */
export function scoreMessage(text) {
  if (!ready || keywords.length === 0) return 0;
  const lower = text.toLowerCase();
  const hits = keywords.filter((k) => lower.includes(k)).length;
  return hits / keywords.length;
}

/**
 * Convert a topic affinity score to a claim delay in milliseconds.
 * High-affinity bots claim immediately; low-affinity bots wait, giving
 * the relevant persona time to win the Redis SET NX race.
 */
export function getDelayMs(score) {
  if (score >= 0.4) return 0;
  if (score >= 0.15) return 400;
  return 1200;
}
