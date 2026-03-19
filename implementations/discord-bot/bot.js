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

  // Only respond when mentioned
  if (!message.mentions.has(client.user)) return;

  // Strip the mention(s) from the message text
  const userMessage = message.content
    .replace(/<@!?\d+>/g, "")
    .trim();

  if (!userMessage) return;

  try {
    await message.channel.sendTyping();

    // Fetch recent channel messages for conversation context
    const recent = await message.channel.messages.fetch({ limit: CONTEXT_MESSAGES + 1 });
    const contextMessages = [...recent.values()]
      .filter((m) => m.id !== message.id)
      .reverse()
      .map((m) => {
        const name = m.author.bot ? "Matt" : m.member?.displayName ?? m.author.username;
        const text = m.content.replace(/<@!?\d+>/g, "").trim();
        return `${name}: ${text}`;
      })
      .filter((line) => line.length > 6); // skip empty/mention-only messages

    const conversationContext = contextMessages.join("\n");

    // Retrieve similar examples (no query enrichment — fast, lore in prompt)
    const results = await retrieve(userMessage, 5, conversationContext);

    const systemPrompt = buildSystemPrompt(baseSystemPrompt, results);
    const reply = await generate(systemPrompt, [], userMessage);

    await message.reply(reply);
  } catch (err) {
    console.error("Error generating response:", err);
    // Silent fail — don't spam the channel with error messages
  }
});

client.login(process.env.DISCORD_TOKEN);
