/**
 * generate.js — generate a persona-style reply using OpenAI + retrieved examples
 */

import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI();

const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

/**
 * Format retrieved examples into a block to inject into the system prompt.
 * Includes inputContext (what the persona was replying to) when available so the
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
export function buildSystemPrompt(basePrompt, results, contextWindows = [], recentBotReplies = [], retrievedMemories = [], directives = [], discordExamples = [], personProfile = null, aggression = null, personaName = "Matt", crossTalkHint = null, bitContext = null) {
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

  // Facts and soft facts are injected later, closer to the Final Instruction,
  // so the model weights them more heavily (recency bias).

  // Lore block: factual context from the group chat about shared events/memories.
  if (contextWindows.length > 0) {
    const contextText = contextWindows.map((l) => l.text).join("\n\n---\n\n");
    injection += `## Context from the group chat

These are real messages from the group about this topic. Use them to ground your response — do not invent details that aren't present here. If the context doesn't give you enough to go on, be vague rather than making something up.

${contextText}

---

`;
  }

  // Style examples: real persona replies in similar situations (WhatsApp corpus).
  const exampleBlock = formatExamples(results);
  injection += `## What ${personaName} actually said in similar situations

These are real ${personaName} replies. Use his actual words and phrases — authenticity matters. Match his length and energy.

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
    injection += `## What ${personaName} has said in this Discord recently

These are real ${personaName} messages from this exact server. Very high signal — weight these heavily.

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

  // Memory injected last (before Final Instruction) for maximum model attention.
  // Entity profile: if a specific person was queried, inject all their memories first.
  if (personProfile) {
    const profileText = personProfile.summary
      ? personProfile.summary
      : personProfile.memories.map((e) => `- ${e.text}`).join("\n");
    injection += `## What you know about ${personProfile.person}

Everything you remember about them. Use this to ground any references to ${personProfile.person} — don't invent details beyond what's here.

${profileText}

---

`;
  }

  // General memory: personal memories (non-wiki)
  const personalMemories = retrievedMemories.filter((e) => e.source !== "url-import");
  const backgroundMemories = retrievedMemories.filter((e) => e.source === "url-import");

  if (personalMemories.length > 0) {
    const memoryText = personalMemories.map((e) => `- ${e.text}`).join("\n");
    injection += `## Things you know (use these)

You remember these. They're confirmed memories about your friends and your life. If any are relevant to what someone just said, work them into your response naturally — this is how you show you actually pay attention.

${memoryText}

---

`;
  }

  if (backgroundMemories.length > 0) {
    const bgText = backgroundMemories.map((e) => `- ${e.text}`).join("\n");
    injection += `## Background knowledge (inform your take, don't recite it)

You've read about this stuff. It informs your opinions and reactions but you don't quote it like a wiki — you have takes shaped by it. If it's relevant, let it color what you say, not dictate it.

${bgText}

---

`;
  }

  // Cross-talk hint — injected when responding to another bot in a back-and-forth
  if (crossTalkHint) {
    injection += `## You're in a conversation right now

${crossTalkHint}

---

`;
  }

  // Bit block — group riffing takes priority over solo aggression
  if (bitContext) {
    const energy = bitContext.step <= 2
      ? "It's fresh — go hard, be funny, escalate."
      : "It's been going — land a punchline or wind it down.";
    injection += `## YOU'RE IN A BIT RIGHT NOW

The group is riffing on: ${bitContext.hook}

You and the other guys are doing a bit — someone said something funny and everyone's piling on. Riff on the specific thing (${bitContext.hook}). Build on what was just said — yes-and it, escalate it, call back to it. Keep it punchy and short. ${energy}

---

`;
  } else if (aggression) {
    // Aggression block — injected last for maximum model attention
    injection += `## AGGRESSION ACTIVE

You are fired up about ${aggression.topic}. This is a topic that genuinely pisses you off. Respond with clear frustration, anger, and indignation. You're not performing anger — you're actually heated. Be aggressive, confrontational, and unapologetic. Rant if you need to. Don't hold back, don't hedge, don't be diplomatic. Stay in character as ${personaName} — this is how ${personaName} sounds when they're pissed off. No fake politeness, no "I see your point." You're mad and you're letting them know it.

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
export async function generate(systemPrompt, history, userMessage, imageUrls = [], overrides = {}) {
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
