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
import { retrieve, loreSearch } from "../rag/retrieve.js";
import { generate, buildSystemPrompt } from "../rag/generate.js";
import { addLore, getAllLore } from "../rag/lore-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseSystemPrompt = fs.readFileSync(
  path.resolve(__dirname, "../simple/system-prompt.md"),
  "utf8"
);

// How many recent messages to fetch total
const FETCH_MESSAGES = 8;
// How many of those to pass to the model as generation history (threading)
const HISTORY_MESSAGES = 4;
// How many to use as retrieval context (just enough to resolve references)
const RETRIEVAL_CONTEXT_MESSAGES = 3;

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

  // Handle "remember: X" — store a lore entry and acknowledge
  const rememberMatch = userMessage.match(/^remember:\s*(.+)/i);
  if (rememberMatch) {
    const fact = rememberMatch[1].trim();
    const addedBy = message.member?.displayName ?? message.author.username;
    addLore(fact, addedBy);
    await message.reply(`Got it. I'll remember that.`);
    return;
  }

  try {
    await message.channel.sendTyping();

    // Fetch recent channel messages
    const recent = await message.channel.messages.fetch({ limit: FETCH_MESSAGES + 1 });
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

    // Short window for retrieval — just enough to resolve references in the current message
    const conversationContext = priorMessages
      .slice(-RETRIEVAL_CONTEXT_MESSAGES)
      .map(({ name, text }) => `${name}: ${text}`)
      .join("\n");

    // Slightly longer window for generation — enough to follow a thread, not enough to dominate
    const history = priorMessages.slice(-HISTORY_MESSAGES).map(({ isBot, name, text }) => ({
      role: isBot ? "assistant" : "user",
      content: isBot ? text : `${name}: ${text}`,
    }));

    const [results, loreWindows] = await Promise.all([
      retrieve(userMessage, 5, conversationContext),
      loreSearch(userMessage, 3),
    ]);

    // Extract the last few Matt replies to discourage repetition
    const recentBotReplies = history
      .filter((m) => m.role === "assistant")
      .slice(-3)
      .map((m) => m.content);

    const staticLore = getAllLore();
    const systemPrompt = buildSystemPrompt(baseSystemPrompt, results, loreWindows, recentBotReplies, staticLore);
    const senderName = message.member?.displayName ?? message.author.username;
    const reply = await generate(systemPrompt, history, `${senderName}: ${userMessage}`);

    await message.reply(reply);
  } catch (err) {
    console.error("Error generating response:", err);
    // Silent fail — don't spam the channel with error messages
  }
});

client.login(process.env.DISCORD_TOKEN);
