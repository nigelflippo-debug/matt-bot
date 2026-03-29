/**
 * generate.js — generate a persona-style reply using OpenAI + retrieved examples
 */

import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI();

const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

// ---------------------------------------------------------------------------
// Section renderers — pure functions, each returns a markdown block string
// ---------------------------------------------------------------------------

function formatExamplePair({ inputContext, response }) {
  if (inputContext) {
    const contextLines = inputContext.split("\n").map((l) => `> ${l}`).join("\n");
    return `${contextLines}\n${response}`;
  }
  return response;
}

function rulesSection(directives) {
  const text = directives.map((e) => `- ${e.text}`).join("\n");
  return `## Rules (hard constraints — check these before every response)

These override your defaults. Before generating, verify your response does not violate any of these:

${text}

---

`;
}

function contextWindowsSection(contextWindows) {
  const text = contextWindows.map((l) => l.text).join("\n\n---\n\n");
  return `## Context from the group chat

These are real messages from the group about this topic. Use them to ground your response — do not invent details that aren't present here. If the context doesn't give you enough to go on, be vague rather than making something up.

${text}

---

`;
}

function styleExamplesSection(results, personaName) {
  const text = results.map(formatExamplePair).join("\n\n");
  return `## What ${personaName} actually said in similar situations

These are real ${personaName} replies. Use his actual words and phrases — authenticity matters. Match his length and energy.

${text}

---

`;
}

function discordExamplesSection(discordExamples, personaName) {
  const text = discordExamples.map(formatExamplePair).join("\n\n");
  return `## What ${personaName} has said in this Discord recently

These are real ${personaName} messages from this exact server. Very high signal — weight these heavily.

${text}

---

`;
}

function antiRepetitionSection(recentBotReplies) {
  return `## What you just said (do not repeat these patterns)

${recentBotReplies.join("\n")}

Vary your move. If you used a short quip last time, try a different angle this time. Don't open the same way twice in a row.

---

`;
}

function personProfileSection(personProfile) {
  const profileText = personProfile.summary
    ? personProfile.summary
    : personProfile.memories.map((e) => `- ${e.text}`).join("\n");
  return `## What you know about ${personProfile.person}

Everything you remember about them. Use this to ground any references to ${personProfile.person} — don't invent details beyond what's here.

${profileText}

---

`;
}

function personalMemoriesSection(memories) {
  const text = memories.map((e) => `- ${e.text}`).join("\n");
  return `## Things you know (use these)

You remember these. They're confirmed memories about your friends and your life. If any are relevant to what someone just said, work them into your response naturally — this is how you show you actually pay attention.

${text}

---

`;
}

function backgroundMemoriesSection(memories) {
  const text = memories.map((e) => `- ${e.text}`).join("\n");
  return `## Background knowledge (inform your take, don't recite it)

You've read about this stuff. It informs your opinions and reactions but you don't quote it like a wiki — you have takes shaped by it. If it's relevant, let it color what you say, not dictate it.

${text}

---

`;
}

function crossTalkSection(hint) {
  return `## You're in a conversation right now

${hint}

---

`;
}

function bitSection(bitContext) {
  const energy = bitContext.step <= 2
    ? "It's fresh — go hard, be funny, escalate."
    : "It's been going — land a punchline or wind it down.";
  return `## YOU'RE IN A BIT RIGHT NOW

The group is riffing on: ${bitContext.hook}

You and the other guys are doing a bit — someone said something funny and everyone's piling on. Riff on the specific thing (${bitContext.hook}). Build on what was just said — yes-and it, escalate it, call back to it. Keep it punchy and short. ${energy}

---

`;
}

function aggressionSection(aggression, personaName) {
  return `## AGGRESSION ACTIVE

You are fired up about ${aggression.topic}. This is a topic that genuinely pisses you off. Respond with clear frustration, anger, and indignation. You're not performing anger — you're actually heated. Be aggressive, confrontational, and unapologetic. Rant if you need to. Don't hold back, don't hedge, don't be diplomatic. Stay in character as ${personaName} — this is how ${personaName} sounds when they're pissed off. No fake politeness, no "I see your point." You're mad and you're letting them know it.

---

`;
}

// ---------------------------------------------------------------------------
// Public: buildSystemPrompt
// ---------------------------------------------------------------------------

/**
 * Build the full system prompt by injecting context sections into the base.
 *
 * Inserts before "## Final Instruction" so examples and retrieved context
 * are positioned just before the instruction the model executes.
 *
 * @param {string} basePrompt
 * @param {Object} ctx
 * @param {Array}       ctx.results            - RAG examples from corpus
 * @param {Array}       [ctx.contextWindows]   - corpus window keyword matches
 * @param {Array}       [ctx.recentBotReplies]
 * @param {Array}       [ctx.retrievedMemories]
 * @param {Array}       [ctx.directives]
 * @param {Array}       [ctx.discordExamples]
 * @param {Object|null} [ctx.personProfile]
 * @param {Object|null} [ctx.aggression]
 * @param {string}      [ctx.personaName]
 * @param {string|null} [ctx.crossTalkHint]
 * @param {Object|null} [ctx.bitContext]       - { hook, step }
 */
export function buildSystemPrompt(basePrompt, ctx) {
  const {
    results = [],
    contextWindows = [],
    recentBotReplies = [],
    retrievedMemories = [],
    directives = [],
    discordExamples = [],
    personProfile = null,
    aggression = null,
    personaName = "Matt",
    crossTalkHint = null,
    bitContext = null,
  } = ctx;

  const personalMemories = retrievedMemories.filter((e) => e.source !== "url-import");
  const backgroundMemories = retrievedMemories.filter((e) => e.source === "url-import");

  const injection = [
    directives.length > 0        && rulesSection(directives),
    contextWindows.length > 0    && contextWindowsSection(contextWindows),
    styleExamplesSection(results, personaName),
    discordExamples.length > 0   && discordExamplesSection(discordExamples, personaName),
    recentBotReplies.length > 0  && antiRepetitionSection(recentBotReplies),
    personProfile                && personProfileSection(personProfile),
    personalMemories.length > 0  && personalMemoriesSection(personalMemories),
    backgroundMemories.length > 0 && backgroundMemoriesSection(backgroundMemories),
    crossTalkHint                && crossTalkSection(crossTalkHint),
    bitContext
      ? bitSection(bitContext)
      : (aggression && aggressionSection(aggression, personaName)),
  ].filter(Boolean).join("");

  return basePrompt.replace("## Final Instruction", `${injection}## Final Instruction`);
}

// ---------------------------------------------------------------------------
// Public: generate
// ---------------------------------------------------------------------------

/**
 * Generate a reply.
 *
 * @param {string}   systemPrompt - full system prompt (base + injected examples)
 * @param {Array}    history      - prior conversation turns [{role, content}]
 * @param {string}   userMessage  - the incoming message to respond to
 * @param {string[]} imageUrls    - optional image attachment URLs
 * @param {Object}   overrides    - optional model parameter overrides
 */
export async function generate(systemPrompt, history, userMessage, imageUrls = [], overrides = {}) {
  const userContent = imageUrls.length > 0
    ? [...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })), { type: "text", text: userMessage }]
    : userMessage;

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: overrides.max_tokens ?? 300,
    temperature: overrides.temperature ?? 0.8,
    frequency_penalty: 0.3,
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

  let reply = response.choices[0].message.content.trim();
  // Strip accidental name prefix — model sometimes mimics "Name: message" training data format
  // Only matches capitalized proper-name patterns like "Reed: " or "Reed Zacharias: "
  reply = reply.replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?:\s+/, "");
  return reply;
}
