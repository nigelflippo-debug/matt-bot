/**
 * aggression.js — classify whether a message touches a provocation topic
 *
 * Uses gpt-4o-mini to detect direct and indirect references to trigger topics.
 * Returns {triggered, topic} so the caller can inject aggression into the prompt.
 */

import OpenAI from "openai";

const client = new OpenAI();

function buildClassificationPrompt(topics) {
  return `You are a topic classifier. Given a message and optional conversation context, determine if the message touches ANY of these topics — directly or indirectly:

${topics.map((t) => `- ${t}`).join("\n")}

Indirect references count. Examples:
- "the city" or "Manhattan" → New York City
- "the laptop thing" → Hunter Biden
- "that's so Boston" (implying racial tensions) → Boston racism
- "what he said at the press conference" (about the president, if Biden) → Joe Biden

Respond with ONLY valid JSON, no other text:
{"triggered": true, "topic": "the matched topic"}
or
{"triggered": false, "topic": null}`;
}

/**
 * Classify whether a message touches a provocation topic.
 *
 * @param {string} userMessage - the incoming message text
 * @param {string} conversationContext - recent prior messages for reference resolution
 * @param {string[]} topics - persona-specific list of provocation topics
 * @returns {Promise<{triggered: boolean, topic: string|null}>}
 */
export async function classifyAggression(userMessage, conversationContext = "", topics = []) {
  if (topics.length === 0) return { triggered: false, topic: null };
  try {
    const contextBlock = conversationContext
      ? `Recent conversation:\n${conversationContext}\n\nNew message: ${userMessage}`
      : userMessage;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 50,
      temperature: 0,
      messages: [
        { role: "system", content: buildClassificationPrompt(topics) },
        { role: "user", content: contextBlock },
      ],
    });

    const raw = response.choices[0].message.content.trim();
    const result = JSON.parse(raw);
    return {
      triggered: result.triggered === true,
      topic: result.topic ?? null,
    };
  } catch {
    // Classification failure should never block a reply
    return { triggered: false, topic: null };
  }
}
