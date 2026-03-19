/**
 * generate.js — generate a Matt-style reply using OpenAI + retrieved examples
 */

import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI();

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/**
 * Format retrieved examples into a block to inject into the system prompt.
 */
function formatExamples(results) {
  return results.map(({ response }) => response).join("\n");
}

/**
 * Build the full system prompt by injecting retrieved examples into the base.
 *
 * Inserts before "## Final Instruction" so the static examples and retrieved
 * examples are both present.
 */
export function buildSystemPrompt(basePrompt, results, loreWindows = [], recentBotReplies = [], staticLore = []) {
  let injection = "";

  // Static lore: user-curated facts and corrections, always authoritative.
  if (staticLore.length > 0) {
    const loreText = staticLore.map((e) => `- ${e.text}`).join("\n");
    injection += `## Authoritative facts (treat as ground truth)

These facts have been confirmed or corrected by the group. If anything in your training contradicts these, defer to this list.

${loreText}

---

`;
  }

  // Lore block: factual context from the group chat about shared events/memories.
  if (loreWindows.length > 0) {
    const loreText = loreWindows.map((l) => l.text).join("\n\n---\n\n");
    injection += `## Context from the group chat

These are real messages from the group about this topic. Use them to ground your response — do not invent details that aren't present here. If the context doesn't give you enough to go on, be vague rather than making something up.

${loreText}

---

`;
  }

  // Style examples: real Matt replies in similar situations.
  const exampleBlock = formatExamples(results);
  injection += `## What Matt actually said in similar situations

These are real Matt replies. Use his actual words and phrases — authenticity matters. Match his length and energy.

${exampleBlock}

---

`;

  // Anti-repetition: surface what Matt just said so the model avoids recycling it.
  if (recentBotReplies.length > 0) {
    injection += `## What you just said (do not repeat these patterns)

${recentBotReplies.join("\n")}

Vary your move. If you used a short quip last time, try a different angle this time. Don't open the same way twice in a row.

---

`;
  }

  return basePrompt.replace("## Final Instruction", `${injection}## Final Instruction`);
}

/**
 * Generate a reply.
 *
 * @param {string} systemPrompt - full system prompt (base + injected examples)
 * @param {Array}  history      - prior conversation turns [{role, content}]
 * @param {string} userMessage  - the incoming message to respond to
 */
export async function generate(systemPrompt, history, userMessage) {
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 300,
    temperature: 0.8,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userMessage },
    ],
  });

  const { prompt_tokens, completion_tokens } = response.usage;
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    stage: "generation_complete",
    model: MODEL,
    promptTokens: prompt_tokens,
    completionTokens: completion_tokens,
    finishReason: response.choices[0].finish_reason,
  }));

  return response.choices[0].message.content.trim();
}
