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
import { addLore, removeLore, getAllLore, embedPendingLore, retrieveLore, getDirectives, pruneExpired, applyDecay, extractImplicit, addImplicit } from "../rag/lore-store.js";
import { logMattMessage, embedPendingDiscord, retrieveDiscord } from "../rag/discord-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseSystemPrompt = fs.readFileSync(
  path.resolve(__dirname, "../simple/system-prompt.md"),
  "utf8"
);

// How many recent messages to fetch total
const FETCH_MESSAGES = 8;

// Recency buffer — tracks recently injected example IDs to prevent repetition
const RECENCY_BUFFER_SIZE = 20;
const recentExampleIds = new Set();
const recentExampleOrder = [];

function trackExamples(ids) {
  for (const id of ids) {
    if (recentExampleIds.has(id)) continue;
    recentExampleOrder.push(id);
    recentExampleIds.add(id);
    if (recentExampleOrder.length > RECENCY_BUFFER_SIZE) {
      recentExampleIds.delete(recentExampleOrder.shift());
    }
  }
}
// How many of those to pass to the model as generation history (threading)
const HISTORY_MESSAGES = 4;
// How many to use as retrieval context (just enough to resolve references)
const RETRIEVAL_CONTEXT_MESSAGES = 3;

// Admin user IDs — comma-separated Discord user IDs in ADMIN_USER_IDS env var
const ADMIN_IDS = new Set(
  (process.env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
);
function isAdmin(userId) { return ADMIN_IDS.has(userId); }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function runImplicitExtraction(conversationContext, requestId, message) {
  try {
    const facts = await extractImplicit(conversationContext);
    log(requestId, "implicit_extract", { found: facts.length, facts: facts.map((f) => f.slice(0, 60)) });
    let anyProvisional = false;
    let anyPromoted = false;
    for (const fact of facts) {
      const result = await addImplicit(fact);
      log(requestId, "implicit_store", { fact: fact.slice(0, 60), action: result.action });
      if (result.action === "added") anyProvisional = true;
      if (result.action === "promoted") anyPromoted = true;
    }
    if (anyPromoted) await message.react("🧠").catch(() => {});
    if (anyProvisional) await message.react("🤔").catch(() => {});
  } catch (err) {
    log(requestId, "implicit_error", { message: err.message });
  }
}

function log(requestId, stage, data = {}) {
  const entry = { ts: new Date().toISOString(), requestId, stage, ...data };
  console.log(JSON.stringify(entry));
}

client.once(Events.ClientReady, (c) => {
  const pruned = pruneExpired();
  const decay = applyDecay();
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "ready", tag: c.user.tag, prunedLore: pruned, decayed: decay.decayed, decayPruned: decay.pruned }));
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

  // Strip the mention(s) from the message text; detect --debug flag
  const rawMessage = message.content.replace(/<@!?\d+>/g, "").trim();
  const debugMode = /[-\u2013\u2014]{1,2}debug\s*$/i.test(rawMessage);
  const userMessage = rawMessage.replace(/[-\u2013\u2014]{1,2}debug\s*$/i, "").trim();

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

  // Handle "remember: X" and "remember for now: X" — store a lore entry and acknowledge
  const rememberMatch = userMessage.match(/^remember(?:\s+for\s+now)?:\s*(.+)/i);
  const rememberIsEpisodic = /^remember\s+for\s+now:/i.test(userMessage);
  if (rememberMatch) {
    if (!rememberIsEpisodic && !isAdmin(message.author.id)) {
      await message.reply(`nah`);
      return;
    }
    // Prefix "for now:" so the classifier sees the episodic hint in the text
    const fact = rememberIsEpisodic ? `for now: ${rememberMatch[1].trim()}` : rememberMatch[1].trim();
    const result = await addLore(fact, senderName);
    log(requestId, "lore_write", { fact, addedBy: senderName, action: result.action });
    const acks = {
      added:   result.category === "episodic" ? `Got it. I'll remember that for now (expires in 7 days).` : `Got it. I'll remember that.`,
      merged:  `Yeah I already kind of knew that, updated.`,
      skipped: `I already know that.`,
      capped:  `My brain is full. Someone needs to forget something first.`,
      split:   `Got it. I split that into a fact and a rule.`,
    };
    await message.reply(acks[result.action] ?? `Got it.`);
    const reacts = {
      added:   result.category === "directive" ? "🫡" : result.category === "episodic" ? "⏳" : "🧠",
      merged:  "✏️",
      skipped: "👍",
      split:   "✂️",
    };
    const emoji = reacts[result.action];
    if (emoji) await message.react(emoji).catch(() => {});
    return;
  }

  // Handle "list memory" — send all lore entries as a JSON file attachment
  if (/^list memory$/i.test(userMessage)) {
    const entries = getAllLore();
    if (entries.length === 0) {
      await message.reply(`No lore stored yet.`);
      return;
    }
    const sorted = [...entries].sort((a, b) => (b.confidence ?? 1) - (a.confidence ?? 1));
    const counts = sorted.reduce((acc, e) => { acc[e.category] = (acc[e.category] ?? 0) + 1; return acc; }, {});
    const categorySummary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
    const high = sorted.filter((e) => (e.confidence ?? 1) >= 0.8).length;
    const medium = sorted.filter((e) => (e.confidence ?? 1) >= 0.5 && (e.confidence ?? 1) < 0.8).length;
    const low = sorted.filter((e) => (e.confidence ?? 1) < 0.5).length;
    const confidenceSummary = `${high} high, ${medium} medium, ${low} low`;
    const buf = Buffer.from(JSON.stringify(sorted, null, 2), "utf8");
    await message.reply({
      content: `**${sorted.length} entries** (${categorySummary}) — ${confidenceSummary} confidence`,
      files: [{ attachment: buf, name: "lore.json" }],
    });
    return;
  }

  // Handle "forget: X" — remove lore entries matching a keyword
  const forgetMatch = userMessage.match(/^forget:\s*(.+)/i);
  if (forgetMatch) {
    if (!isAdmin(message.author.id)) {
      await message.reply(`nah`);
      return;
    }
    const keyword = forgetMatch[1].trim();
    const { removed, entries: removedEntries } = await removeLore(keyword);
    log(requestId, "lore_removed", { keyword, removed });
    if (removed === 0) {
      await message.reply(`I don't have anything about that.`);
    } else {
      const list = removedEntries.map((e) => `• [${e.category}] ${e.text}`).join("\n");
      await message.reply(`Forgotten ${removed} thing${removed === 1 ? "" : "s"}:\n${list}`);
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

    // If this is real Matt posting (not the bot), log the exchange as training data
    const mattDiscordId = process.env.MATT_DISCORD_USER_ID;
    if (mattDiscordId && message.author.id === mattDiscordId && userMessage) {
      const contextWindow = priorMessages
        .slice(-3)
        .map(({ name, text }) => `${name}: ${text}`)
        .join("\n");
      logMattMessage(contextWindow, `Matt: ${userMessage}`);
    }

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
      retrieve(retrievalQuery, 5, conversationContext, recentExampleIds),
      loreSearch(retrievalQuery, 3),
    ]);
    trackExamples(results.map((r) => r.id));
    const t2 = Date.now();

    log(requestId, "retrieval_complete", {
      ragResults: results.length,
      loreWindows: loreWindows.length,
      ms: t2 - t1,
    });

    // Embed any pending lore + discord entries, then retrieve relevant facts + directives + discord examples
    await Promise.all([embedPendingLore(), embedPendingDiscord()]);
    const [retrievedFacts, directives, discordExamples] = await Promise.all([
      retrieveLore(retrievalQuery, 5),
      Promise.resolve(getDirectives()),
      retrieveDiscord(retrievalQuery, 3),
    ]);
    log(requestId, "lore_retrieved", { facts: retrievedFacts.length, directives: directives.length, discordExamples: discordExamples.length });

    // Extract the last few Matt replies to discourage repetition
    const recentBotReplies = history
      .filter((m) => m.role === "assistant")
      .slice(-3)
      .map((m) => m.content);

    const systemPrompt = buildSystemPrompt(baseSystemPrompt, results, loreWindows, recentBotReplies, retrievedFacts, directives, discordExamples);

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

    // Fire implicit extraction in background — doesn't block the reply
    if (userMessage.length >= 30) {
      const extractionContext = [
        ...priorMessages.slice(-3).map(({ name, text }) => `${name}: ${text}`),
        `${senderName}: ${userMessage}`,
      ].join("\n");
      runImplicitExtraction(extractionContext, requestId, message).catch(() => {});
    }

    if (debugMode) {
      const debugData = {
        directives: directives.map((e) => e.text),
        lore_facts: retrievedFacts.map((e) => e.text),
        corpus_windows: loreWindows.map((w) => w.text),
        discord_examples: discordExamples.map((e) => e.response),
        rag_examples: results.map((r) => r.response),
      };
      const buf = Buffer.from(JSON.stringify(debugData, null, 2), "utf8");
      await message.channel.send({
        content: `**[debug]** directives:${directives.length} facts:${retrievedFacts.length} corpus:${loreWindows.length} discord:${discordExamples.length} rag:${results.length}`,
        files: [{ attachment: buf, name: "debug.json" }],
      });
    }
  } catch (err) {
    clearInterval(typingInterval);
    log(requestId, "error", { message: err.message, stack: err.stack });
  }
});

client.login(process.env.DISCORD_TOKEN);
