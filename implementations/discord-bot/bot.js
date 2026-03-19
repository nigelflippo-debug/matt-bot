/**
 * bot.js — Matt Bot Discord bot
 *
 * Responds as Matt when mentioned in a Discord channel.
 * Uses the simple pipeline: light retrieval (K=5) + lore-heavy system prompt.
 */

import "dotenv/config";
import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { retrieve } from "../rag/retrieve.js";
import { generate, buildSystemPrompt } from "../rag/generate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseSystemPrompt = fs.readFileSync(
  path.resolve(__dirname, "../simple/system-prompt.md"),
  "utf8"
);

// Number of recent channel messages to pass as conversation context
const CONTEXT_MESSAGES = 10;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Matt Bot ready — logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore messages from bots (including ourselves)
  if (message.author.bot) return;

  // Respond to everything in #gweeod, or when mentioned anywhere else
  const inGweeod = message.channel.name === "gweeod";
  if (!inGweeod && !message.mentions.has(client.user)) return;

  // Strip the mention(s) from the message text
  const userMessage = message.content
    .replace(/<@!?\d+>/g, "")
    .trim();

  if (!userMessage) return;

  try {
    await message.channel.sendTyping();

    // Fetch recent channel messages for conversation context
    const recent = await message.channel.messages.fetch({ limit: CONTEXT_MESSAGES + 1 });
    const priorMessages = [...recent.values()]
      .filter((m) => m.id !== message.id)
      .reverse()
      .map((m) => {
        const isBot = m.author.bot;
        const name = isBot ? "Matt" : m.member?.displayName ?? m.author.username;
        const text = m.content.replace(/<@!?\d+>/g, "").trim();
        return { isBot, name, text };
      })
      .filter(({ text }) => text.length > 0);

    // String form for retrieval
    const conversationContext = priorMessages
      .map(({ name, text }) => `${name}: ${text}`)
      .join("\n");

    // OpenAI message format for generation — bot turns become assistant, everyone else user
    const history = priorMessages.map(({ isBot, name, text }) => ({
      role: isBot ? "assistant" : "user",
      content: isBot ? text : `${name}: ${text}`,
    }));

    // Retrieve similar examples (no query enrichment — fast, lore in prompt)
    const results = await retrieve(userMessage, 5, conversationContext);

    // Extract the last few Matt replies to discourage repetition
    const recentBotReplies = history
      .filter((m) => m.role === "assistant")
      .slice(-3)
      .map((m) => m.content);

    const systemPrompt = buildSystemPrompt(baseSystemPrompt, results, [], recentBotReplies);
    const senderName = message.member?.displayName ?? message.author.username;
    const reply = await generate(systemPrompt, history, `${senderName}: ${userMessage}`);

    await message.reply(reply);
  } catch (err) {
    console.error("Error generating response:", err);
    // Silent fail — don't spam the channel with error messages
  }
});

client.login(process.env.DISCORD_TOKEN);
