/**
 * bit-detection.js — classify whether a bot message has "bit potential"
 *
 * Uses gpt-4o-mini to detect humor, absurdity, bold claims, callbacks —
 * anything friends would pile on in a group chat.
 * Returns {isBit, hook} so the caller can initiate a group bit via Redis.
 */

import OpenAI from "openai";

const client = new OpenAI();

const CLASSIFICATION_PROMPT = `You detect comedic or riffable moments in a group chat between friends. A "bit" is when someone says something funny, absurd, provocative, or begging for a pile-on — the kind of message where friends can't help but jump in.

Signs of a bit:
- A bold or ridiculous claim ("I could beat any of you in a fight")
- Self-owns or embarrassing admissions
- Absurd hypotheticals or hot takes
- Callbacks to running jokes or group lore
- Playful insults or trash talk aimed at someone
- Something so wrong or dumb that it demands a response

NOT a bit:
- Normal conversation, questions, or logistics
- Genuine emotional moments or serious topics
- Simple agreements or acknowledgments
- Messages that are already part of an ongoing back-and-forth

Given a message and optional conversation context, determine if this is a bit-worthy moment.

Respond with ONLY valid JSON, no other text:
{"isBit": true, "hook": "5-10 word summary of the riffable element"}
or
{"isBit": false, "hook": null}`;

/**
 * Classify whether a bot message has bit potential.
 *
 * @param {string} userMessage - the incoming bot message text
 * @param {string} conversationContext - recent prior messages for context
 * @returns {Promise<{isBit: boolean, hook: string|null}>}
 */
export async function classifyBit(userMessage, conversationContext = "") {
  try {
    const contextBlock = conversationContext
      ? `Recent conversation:\n${conversationContext}\n\nNew message: ${userMessage}`
      : userMessage;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 80,
      temperature: 0,
      messages: [
        { role: "system", content: CLASSIFICATION_PROMPT },
        { role: "user", content: contextBlock },
      ],
    });

    const raw = response.choices[0].message.content.trim();
    const result = JSON.parse(raw);
    return {
      isBit: result.isBit === true,
      hook: result.hook ?? null,
    };
  } catch {
    // Classification failure should never block a reply
    return { isBit: false, hook: null };
  }
}
