/**
 * generate.js — generate a Matt-style reply using OpenAI + retrieved examples
 */

import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI();

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/**
 * Format retrieved examples into a block to inject into the system prompt.
 * Shows context → Matt's reply so the model sees the full situational pattern.
 */
function formatExamples(results) {
  // Only show Matt's reply lines, not the surrounding context.
  // Context is used for retrieval (finding the right situations) but shown
  // to the generation model it causes narrative synthesis instead of voice mirroring.
  return results.map(({ response }) => response).join("\n");
}

/**
 * Build the full system prompt by injecting retrieved examples into the base.
 *
 * Inserts before "## Final Instruction" so the static examples and retrieved
 * examples are both present.
 */
export function buildSystemPrompt(basePrompt, results, loreWindows = []) {
  let injection = "";

  // Lore block: factual context from the group chat about shared events/memories.
  // Injected first so it's available as grounding before the style examples.
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

These are real replies from Matt in situations like this one. Your response should belong in this list — same length, same register, same kind of move. Do not produce something more elaborate or polished than what's here.

${exampleBlock}

---

`;

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
    temperature: 0.7,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userMessage },
    ],
  });
  return response.choices[0].message.content.trim();
}
