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
import { addLore, removeLore, getAllLore, consolidateLore, embedPendingLore, retrieveLore, getDirectives } from "../rag/lore-store.js";

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

function log(requestId, stage, data = {}) {
  const entry = { ts: new Date().toISOString(), requestId, stage, ...data };
  console.log(JSON.stringify(entry));
}

client.once(Events.ClientReady, (c) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "ready", tag: c.user.tag }));
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore messages from bots (including ourselves)
  if (message.author.bot) return;

  const inGweeod = message.channel.name === "gweeod";
  const botMentioned = message.mentions.has(client.user);
  const onlyOthersMentioned = message.mentions.users.size > 0 && !botMentioned;

  // If someone else is tagged (and not the bot), stay out of it
  if (onlyOthersMentioned) return;
  // Outside gweeod, only respond when explicitly mentioned
  if (!inGweeod && !botMentioned) return;

  // Strip the mention(s) from the message text
  const userMessage = message.content
    .replace(/<@!?\d+>/g, "")
    .trim();

  // Collect image attachments
  const imageUrls = [...message.attachments.values()]
    .filter((a) => a.contentType?.startsWith("image/"))
    .map((a) => a.url);

  if (!userMessage && imageUrls.length === 0) return;

  const requestId = message.id.slice(-6);
  const senderName = message.member?.displayName ?? message.author.username;

  log(requestId, "message_received", {
    channel: message.channel.name,
    sender: senderName,
    preview: userMessage.slice(0, 80),
  });

  // Handle "remember: X" — store a lore entry and acknowledge
  const rememberMatch = userMessage.match(/^remember:\s*(.+)/i);
  if (rememberMatch) {
    const fact = rememberMatch[1].trim();
    const result = await addLore(fact, senderName);
    log(requestId, "lore_write", { fact, addedBy: senderName, action: result.action });
    const acks = {
      added:   `Got it. I'll remember that.`,
      merged:  `Yeah I already kind of knew that, updated.`,
      skipped: `I already know that.`,
      capped:  `My brain is full. Someone needs to forget something first.`,
      split:   `Got it. I split that into a fact and a rule.`,
    };
    await message.reply(acks[result.action] ?? `Got it.`);
    return;
  }

  // Handle "list memory" — display all current lore entries
  if (/^list memory$/i.test(userMessage)) {
    const entries = getAllLore();
    if (entries.length === 0) {
      await message.reply(`No lore stored yet.`);
      return;
    }
    const lines = entries.map((e, i) => `${i + 1}. [${e.category ?? "fact"}] ${e.text}`);
    const chunks = [];
    let current = `**Lore (${entries.length} entries):**\n`;
    for (const line of lines) {
      if (current.length + line.length + 1 > 1900) {
        chunks.push(current.trimEnd());
        current = "";
      }
      current += line + "\n";
    }
    if (current.trim()) chunks.push(current.trimEnd());
    await message.reply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
      await message.channel.send(chunk);
    }
    return;
  }

  // Handle "consolidate memory" — run full coalesce pass over existing entries
  if (/^consolidate memory$/i.test(userMessage)) {
    try {
      await message.channel.sendTyping();
      const { before, after } = await consolidateLore();
      log(requestId, "lore_consolidated", { before, after });
      await message.reply(`Done. Went from ${before} to ${after} entries.`);
    } catch (err) {
      log(requestId, "lore_consolidate_error", { message: err.message });
      await message.reply(`Something went wrong during consolidation.`);
    }
    return;
  }

  // Handle "forget: X" — remove lore entries matching a keyword
  const forgetMatch = userMessage.match(/^forget:\s*(.+)/i);
  if (forgetMatch) {
    const keyword = forgetMatch[1].trim();
    const removed = await removeLore(keyword);
    log(requestId, "lore_removed", { keyword, removed });
    if (removed === 0) {
      await message.reply(`I don't have anything about that.`);
    } else {
      await message.reply(`Forgotten. Removed ${removed} thing${removed === 1 ? "" : "s"}.`);
    }
    return;
  }

  try {
    await message.channel.sendTyping();
    const typingInterval = setInterval(() => message.channel.sendTyping(), 8000);
    const t0 = Date.now();

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

    log(requestId, "context_fetched", { priorMessageCount: priorMessages.length });

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

    // For image-only messages, fall back to conversation context for retrieval
    const retrievalQuery = userMessage || conversationContext || "reacting to an image";

    const t1 = Date.now();
    const [results, loreWindows] = await Promise.all([
      retrieve(retrievalQuery, 5, conversationContext),
      loreSearch(retrievalQuery, 3),
    ]);
    const t2 = Date.now();

    log(requestId, "retrieval_complete", {
      ragResults: results.length,
      loreWindows: loreWindows.length,
      ms: t2 - t1,
    });

    // Embed any pending lore entries, then retrieve relevant facts + directives
    await embedPendingLore();
    const [retrievedFacts, directives] = await Promise.all([
      retrieveLore(retrievalQuery, 5),
      Promise.resolve(getDirectives()),
    ]);
    log(requestId, "lore_retrieved", { facts: retrievedFacts.length, directives: directives.length });

    // Extract the last few Matt replies to discourage repetition
    const recentBotReplies = history
      .filter((m) => m.role === "assistant")
      .slice(-3)
      .map((m) => m.content);

    const systemPrompt = buildSystemPrompt(baseSystemPrompt, results, loreWindows, recentBotReplies, retrievedFacts, directives);

    log(requestId, "generating");
    const t3 = Date.now();
    const userContent = userMessage ? `${senderName}: ${userMessage}` : `${senderName} sent an image.`;
    const reply = await generate(systemPrompt, history, userContent, imageUrls);
    const t4 = Date.now();

    log(requestId, "generated", {
      ms: t4 - t3,
      replyPreview: reply.slice(0, 80),
      totalMs: t4 - t0,
    });

    clearInterval(typingInterval);
    await message.reply(reply);
    log(requestId, "replied");
  } catch (err) {
    clearInterval(typingInterval);
    log(requestId, "error", { message: err.message, stack: err.stack });
  }
});

client.login(process.env.DISCORD_TOKEN);
