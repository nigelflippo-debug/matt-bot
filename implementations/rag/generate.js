/**
 * generate.js — generate a Matt-style reply using OpenAI + retrieved examples
 */

import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI();

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/**
 * Format retrieved examples into a block to inject into the system prompt.
 * Includes inputContext (what Matt was replying to) when available so the
 * model can judge how the example maps to the current situation.
 */
function formatExamples(results) {
  return results.map(({ inputContext, response }) => {
    if (inputContext) {
      const contextLines = inputContext.split("\n").map((l) => `> ${l}`).join("\n");
      return `${contextLines}\n${response}`;
    }
    return response;
  }).join("\n\n");
}

/**
 * Build the full system prompt by injecting retrieved examples into the base.
 *
 * Inserts before "## Final Instruction" so the static examples and retrieved
 * examples are both present.
 */
export function buildSystemPrompt(basePrompt, results, loreWindows = [], recentBotReplies = [], retrievedFacts = [], directives = [], discordExamples = [], softFacts = []) {
  let injection = "";

  // Directives: behavioral rules the group has set — always inject.
  if (directives.length > 0) {
    const directiveText = directives.map((e) => `- ${e.text}`).join("\n");
    injection += `## Rules (hard constraints — check these before every response)

These override your defaults. Before generating, verify your response does not violate any of these:

${directiveText}

---

`;
  }

  // Retrieved facts: semantically relevant memories from the group's fact store.
  if (retrievedFacts.length > 0) {
    const factText = retrievedFacts.map((e) => `- ${e.text}`).join("\n");
    injection += `## Relevant facts (treat as ground truth)

These facts have been confirmed or stored by the group. If anything in your training contradicts these, defer to this list. If multiple facts are relevant to the topic, weave them together naturally — don't just pick one.

${factText}

---

`;
  }

  // Soft facts: user-asserted (not yet fully confirmed) — inject with weaker framing.
  if (softFacts.length > 0) {
    const softText = softFacts.map((e) => `- ${e.text}`).join("\n");
    injection += `## Possibly true

The group has mentioned these but they haven't been fully confirmed. Use as background context — don't state as definite fact, but don't ignore them either.

${softText}

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

  // Style examples: real Matt replies in similar situations (WhatsApp corpus).
  const exampleBlock = formatExamples(results);
  injection += `## What Matt actually said in similar situations

These are real Matt replies. Use his actual words and phrases — authenticity matters. Match his length and energy.

${exampleBlock}

---

`;

  // Discord examples: recent real Matt messages from this Discord server.
  if (discordExamples.length > 0) {
    const discordBlock = discordExamples.map(({ inputContext, response }) => {
      if (inputContext) {
        const contextLines = inputContext.split("\n").map((l) => `> ${l}`).join("\n");
        return `${contextLines}\n${response}`;
      }
      return response;
    }).join("\n\n");
    injection += `## What Matt has said in this Discord recently

These are real Matt messages from this exact server. Very high signal — weight these heavily.

${discordBlock}

---

`;
  }

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
 * @param {string}   systemPrompt - full system prompt (base + injected examples)
 * @param {Array}    history      - prior conversation turns [{role, content}]
 * @param {string}   userMessage  - the incoming message to respond to
 * @param {string[]} imageUrls    - optional image attachment URLs
 */
export async function generate(systemPrompt, history, userMessage, imageUrls = []) {
  let userContent;
  if (imageUrls.length > 0) {
    userContent = [
      ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
      { type: "text", text: userMessage },
    ];
  } else {
    userContent = userMessage;
  }

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 300,
    temperature: 0.8,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userContent },
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
