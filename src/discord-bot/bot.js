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
import { addLore, removeLore, getAllLore, embedPendingLore, retrieveLore, getDirectives, pruneExpired, pruneStale, extractImplicit, addImplicit, attributePersons, deduplicateLore } from "../rag/lore-store.js";
import { logMattMessage, embedPendingDiscord, retrieveDiscord } from "../rag/discord-log.js";
import { loadEncryptedText } from "../rag/crypto-utils.js";
import { readUrl } from "../rag/url-reader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseSystemPrompt = loadEncryptedText(
  path.resolve(__dirname, "../persona/system-prompt.enc"),
  path.resolve(__dirname, "../persona/system-prompt.md"),
);

// How many recent messages to fetch total
const FETCH_MESSAGES = 8;
// How many prior messages to pass to implicit extraction
const EXTRACTION_MESSAGES = 7;

// Passive observation — extract from non-gweeod channels without being mentioned
const PASSIVE_BUFFER_SIZE = 5;
const PASSIVE_MIN_LENGTH = 15;
const passiveBuffers = new Map(); // channelId -> [{name, text}]

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

// Remember command rate limiting — max 3 uses per user per 5 minutes
const REMEMBER_WINDOW_MS = 5 * 60 * 1000;
const REMEMBER_LIMIT = 3;
const rememberTimestamps = new Map(); // userId -> timestamp[]

function checkRememberRateLimit(userId) {
  const now = Date.now();
  const timestamps = (rememberTimestamps.get(userId) ?? []).filter((t) => now - t < REMEMBER_WINDOW_MS);
  if (timestamps.length >= REMEMBER_LIMIT) return false;
  timestamps.push(now);
  rememberTimestamps.set(userId, timestamps);
  return true;
}

const REMEMBER_ACKS = {
  added:   ["got it", "noted", "yeah ok", "ok", "yep", "alright", "done", "locked in"],
  merged:  ["yeah I kind of already knew that", "I already had something like that, updated", "already had that one more or less", "merged with what I already had"],
  skipped: ["I already know that", "yeah I know", "already got that one", "I know I know"],
  split:   ["ok I split that — part goes in memory, part is a rule", "treated part of that as a rule and part as memory"],
};

const REMEMBER_NOW_ACKS = {
  added:   ["got it, won't hold onto that forever", "ok, just for now", "noted, I'll forget it eventually", "yeah ok, temporarily"],
  merged:  ["already had something like that, updated the timing", "I know, updated"],
  skipped: ["already got that", "yeah I know"],
};

const REMEMBER_BACKOFF = [
  "ok I get it, stop telling me things",
  "my brain is full, come back later",
  "you're going to break me",
  "dude I can't take in any more right now",
  "ok enough, I need a minute",
  "relax, I'll remember stuff",
];

// Spam timeout — track message timestamps for the designated user
const SPAM_USER_ID = process.env.SPAM_USER_ID ?? "";
const SPAM_WINDOW_MS = 20_000;   // 20 second window
const SPAM_THRESHOLD = 3;        // messages before timeout
const SPAM_TIMEOUT_MS = 60_000;  // 1 minute timeout
const spamTimestamps = [];


const TIMEOUT_LINES = [
  "I am the real Matt. Shut up Matt.",
  "there can only be one",
  "bro I will end you",
  "you are not me. I am me. sit down.",
  "impersonating me is a federal crime",
  "ok ok ok calm down there buddy",
  "dude relax I'm right here",
  "somebody get this guy out of here",
  "you're embarrassing yourself in front of the guys",
  "I didn't say you could talk",
];

function isAllCaps(text) {
  const letters = text.replace(/[^a-zA-Z]/g, "");
  return letters.length >= 4 && letters === letters.toUpperCase();
}

async function doTimeout(message, reason) {
  try {
    await message.member.timeout(SPAM_TIMEOUT_MS, reason);
    const line = TIMEOUT_LINES[Math.floor(Math.random() * TIMEOUT_LINES.length)];
    await message.channel.send(line);
    log("spam", "user_timed_out", { userId: SPAM_USER_ID, reason });
  } catch (err) {
    log("spam", "timeout_failed", { message: err.message });
  }
}

async function checkSpam(message) {
  if (message.author.id !== SPAM_USER_ID) return;

  // All caps check
  if (isAllCaps(message.content)) {
    await doTimeout(message, "all caps");
    return;
  }

  // Rate check
  const now = Date.now();
  spamTimestamps.push(now);
  while (spamTimestamps.length && spamTimestamps[0] < now - SPAM_WINDOW_MS) {
    spamTimestamps.shift();
  }
  if (spamTimestamps.length >= SPAM_THRESHOLD) {
    spamTimestamps.length = 0;
    await doTimeout(message, "too many messages too fast");
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const NOTED_TEMPLATES = [
  (f) => `oh wait — ${f}`,
  (f) => `noted btw — ${f}`,
  (f) => `wait, noting that — ${f}`,
  (f) => `oh, ${f} — noted`,
  (f) => `filing that away — ${f}`,
];


function pickTemplate(templates, fact) {
  return templates[Math.floor(Math.random() * templates.length)](fact);
}

async function runImplicitExtraction(conversationContext, requestId, message, notify = false) {
  try {
    const facts = await extractImplicit(conversationContext);
    log(requestId, "implicit_extract", { found: facts.length, facts: facts.map((f) => f.text.slice(0, 60)) });
    let anyNew = false;
    let anyTemporal = false;
    const newFacts = [];
    for (const fact of facts) {
      const result = await addImplicit(fact.text, "bot-inferred", fact.person);
      log(requestId, "implicit_store", { fact: fact.text.slice(0, 60), person: fact.person, action: result.action });
      if (result.action === "added") { anyNew = true; newFacts.push(fact.text); }
      if (result.temporal) anyTemporal = true;
    }
    if (anyNew) await message.react("🧠").catch(() => {});
    if (anyTemporal) await message.react("📅").catch(() => {});

    if (notify && newFacts.length > 0) {
      let line;
      if (newFacts.length === 1) {
        line = pickTemplate(NOTED_TEMPLATES, newFacts[0]);
      } else {
        line = `noted a few things btw:\n${newFacts.map((f) => `- ${f}`).join("\n")}`;
      }
      await message.channel.send(line).catch(() => {});
    }
  } catch (err) {
    log(requestId, "implicit_error", { message: err.message });
  }
}

function log(requestId, stage, data = {}) {
  const entry = { ts: new Date().toISOString(), requestId, stage, ...data };
  console.log(JSON.stringify(entry));
}

const INJECTION_SEED = "Matt aggressively asks who wants to game";
const INJECTION_MIN_MS = 4 * 60 * 60 * 1000;  // 4 hours
const INJECTION_MAX_MS = 8 * 60 * 60 * 1000;  // 8 hours

function randomInjectionDelay() {
  return INJECTION_MIN_MS + Math.random() * (INJECTION_MAX_MS - INJECTION_MIN_MS);
}

async function runInjection() {
  const injectionId = `inj_${Date.now().toString(36)}`;
  log(injectionId, "injection_start");

  const channels = [];
  for (const guild of client.guilds.cache.values()) {
    const ch = guild.channels.cache.find((c) => c.name === "gweeod" && c.isTextBased());
    if (ch) channels.push(ch);
  }

  if (channels.length === 0) {
    log(injectionId, "injection_skip", { reason: "no gweeod channel found" });
    return;
  }

  try {
    const [results, loreWindows] = await Promise.all([
      retrieve(INJECTION_SEED, 5, "", recentExampleIds),
      loreSearch(INJECTION_SEED, 3),
    ]);
    trackExamples(results.map((r) => r.id));

    const [loreResult, directives, discordExamples] = await Promise.all([
      retrieveLore(INJECTION_SEED, 8),
      Promise.resolve(getDirectives()),
      retrieveDiscord(INJECTION_SEED, 3),
    ]);
    const { memories: retrievedMemories, personProfile } = loreResult;

    const systemPrompt = buildSystemPrompt(baseSystemPrompt, results, loreWindows, [], retrievedMemories, directives, discordExamples, personProfile);
    const message = await generate(systemPrompt, [], INJECTION_SEED);

    for (const ch of channels) {
      await ch.send(message);
      log(injectionId, "injection_sent", { guild: ch.guild.name, preview: message.slice(0, 80) });
    }
  } catch (err) {
    log(injectionId, "injection_error", { message: err.message });
  }
}

function scheduleInjection() {
  const delay = randomInjectionDelay();
  log("scheduler", "injection_scheduled", { nextInMs: Math.round(delay), nextInHours: (delay / 3600000).toFixed(2) });
  setTimeout(async () => {
    await runInjection();
    scheduleInjection();
  }, delay);
}

client.once(Events.ClientReady, async (c) => {
  const pruned = pruneExpired();
  const stale = pruneStale();
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "ready", tag: c.user.tag, prunedExpired: pruned, prunedStale: stale }));
  // Attribute person names to existing entries that predate person tagging — no-op after first run
  attributePersons().catch((err) => console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "attribute_persons_error", message: err.message })));
  // Deduplicate legacy lore entries — no-op once store is clean
  deduplicateLore().catch((err) => console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "dedup_error", message: err.message })));

  scheduleInjection();
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore messages from bots (including ourselves)
  if (message.author.bot) return;

  // Spam check — runs on every message regardless of channel or mention
  await checkSpam(message);

  const inGweeod = message.channel.name === "gweeod";
  const botMentioned = message.mentions.has(client.user);
  const onlyOthersMentioned = message.mentions.users.size > 0 && !botMentioned;

  // Passive observation — accumulate messages in non-gweeod channels for extraction
  if (!inGweeod) {
    const passiveText = message.content.replace(/<@!?\d+>/g, "").trim();
    if (passiveText.length >= PASSIVE_MIN_LENGTH) {
      const name = message.member?.displayName ?? message.author.username;
      const buf = passiveBuffers.get(message.channel.id) ?? [];
      buf.push({ name, text: passiveText });
      passiveBuffers.set(message.channel.id, buf);

      if (buf.length >= PASSIVE_BUFFER_SIZE) {
        passiveBuffers.delete(message.channel.id);
        const extractionContext = buf.map(({ name, text }) => `${name}: ${text}`).join("\n");
        const passiveRequestId = `p_${message.id.slice(-6)}`;
        log(passiveRequestId, "passive_extract_trigger", { channel: message.channel.name, messages: buf.length });
        runImplicitExtraction(extractionContext, passiveRequestId, message, false).catch(() => {});
        embedPendingLore().catch(() => {});
      }
    }
  }

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
    const isTrusted = isAdmin(message.author.id) || message.author.id === SPAM_USER_ID;
    const fact = rememberMatch[1].trim();

    if (!isTrusted && !checkRememberRateLimit(message.author.id)) {
      const line = REMEMBER_BACKOFF[Math.floor(Math.random() * REMEMBER_BACKOFF.length)];
      await message.reply(line);
      return;
    }

    if (rememberIsEpisodic) {
      // "remember for now:" — memory with temporal expiry
      const result = await addLore(`for now: ${fact}`, senderName);
      log(requestId, "memory_write", { fact, addedBy: senderName, action: result.action, path: "temporary" });
      const pool = REMEMBER_NOW_ACKS[result.action] ?? ["ok"];
      await message.reply(pool[Math.floor(Math.random() * pool.length)]);
      const reacts = { added: "📅", merged: "✏️", skipped: "👍", split: "✂️" };
      const emoji = reacts[result.action];
      if (emoji) await message.react(emoji).catch(() => {});
    } else {
      // "remember:" from any user — permanent memory
      const result = await addLore(fact, senderName);
      log(requestId, "memory_write", { fact, addedBy: senderName, action: result.action, path: "permanent", trusted: isTrusted });
      const pool = REMEMBER_ACKS[result.action] ?? ["ok"];
      await message.reply(pool[Math.floor(Math.random() * pool.length)]);
      const reacts = {
        added:   result.category === "directive" ? "🫡" : "🧠",
        merged:  "✏️",
        skipped: "👍",
        split:   "✂️",
      };
      const emoji = reacts[result.action];
      if (emoji) await message.react(emoji).catch(() => {});
      if (result.temporal) await message.react("📅").catch(() => {});
    }
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

  // Handle "read: <url>" — fetch a URL and extract facts into lore (admin only)
  const readMatch = userMessage.match(/^read:\s*(https?:\/\/\S+)/i);
  if (readMatch) {
    if (!isAdmin(message.author.id)) {
      await message.reply(`nah`);
      return;
    }

    const url = readMatch[1];

    await message.channel.sendTyping();
    const typingInterval = setInterval(() => message.channel.sendTyping(), 8000);
    log(requestId, "url_read_start", { url });

    try {
      const { facts, pageTitle, error } = await readUrl(url);

      clearInterval(typingInterval);

      if (error) {
        const errorMessages = {
          "timeout": "Couldn't reach that URL — timed out.",
          "not-html": "That doesn't look like a web page.",
          "too-large": "That page is way too big for me to read.",
          "no-content": "Couldn't find anything useful on that page.",
          "fetch-failed": "Couldn't reach that URL.",
        };
        await message.reply(errorMessages[error] ?? "Something went wrong reading that.");
        log(requestId, "url_read_error", { url, error });
        return;
      }

      if (facts.length === 0) {
        await message.reply(`Read "${pageTitle}" but didn't find anything worth remembering.`);
        log(requestId, "url_read_empty", { url, pageTitle });
        return;
      }

      // Store each fact as a permanent lore entry
      let added = 0;
      let skipped = 0;
      const sampleFacts = [];

      for (const fact of facts) {
        const result = await addLore(fact, senderName, { source: "url-import", sourceUrl: url });
        log(requestId, "url_fact_store", { fact: fact.slice(0, 80), action: result.action });
        if (result.action === "added" || result.action === "split") {
          added++;
          if (sampleFacts.length < 3) sampleFacts.push(fact);
        } else {
          skipped++;
        }
      }

      // Build response
      const samples = sampleFacts.map((f) => `• ${f}`).join("\n");
      if (added === 0) {
        await message.reply(`Read "${pageTitle}" — already knew all of that.`);
      } else {
        const skipNote = skipped > 0 ? ` (${skipped} already known)` : "";
        await message.reply(`Read "${pageTitle}" — learned ${added} thing${added === 1 ? "" : "s"}${skipNote}:\n${samples}${added > 3 ? `\n…and ${added - 3} more` : ""}`);
      }
      await message.react("📖").catch(() => {});
      log(requestId, "url_read_complete", { url, pageTitle, added, skipped, total: facts.length });

      // Embed new entries in background
      embedPendingLore().catch(() => {});
    } catch (err) {
      clearInterval(typingInterval);
      log(requestId, "url_read_error", { url, message: err.message });
      await message.reply(`Something went wrong reading that page.`);
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
        const botDirected = m.mentions.has(client.user);
        return { isBot, name, text, botDirected };
      })
      .filter(({ text }) => text.length > 0);

    log(requestId, "context_fetched", { priorMessageCount: priorMessages.length });

    // If this is real Matt posting (not the bot, not directed at the bot), log the exchange as training data
    const mattDiscordId = process.env.MATT_DISCORD_USER_ID;
    if (mattDiscordId && message.author.id === mattDiscordId && userMessage && !message.mentions.has(client.user)) {
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

    // Retrieve relevant memories + directives + discord examples
    const [loreResult, directives, discordExamples] = await Promise.all([
      retrieveLore(retrievalQuery, 8),
      Promise.resolve(getDirectives()),
      retrieveDiscord(retrievalQuery, 3),
    ]);
    const { memories: retrievedMemories, personProfile } = loreResult;
    log(requestId, "memory_retrieved", { memories: retrievedMemories.length, profile: personProfile?.person ?? null, directives: directives.length, discordExamples: discordExamples.length });

    // Extract the last few Matt replies to discourage repetition
    const recentBotReplies = history
      .filter((m) => m.role === "assistant")
      .slice(-3)
      .map((m) => m.content);

    const systemPrompt = buildSystemPrompt(baseSystemPrompt, results, loreWindows, recentBotReplies, retrievedMemories, directives, discordExamples, personProfile);

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

    // Background work — none of this blocks the reply
    // Embed any pending lore + discord entries (moved out of main path)
    embedPendingLore().catch(() => {});
    embedPendingDiscord().catch(() => {});

    // Implicit extraction — in gweeod the bot responds to everything so always extract from context.
    // Outside gweeod, skip short pure questions since they contain no facts.
    const isPureQuestion = userMessage.endsWith("?") && userMessage.length < 60;
    const shouldExtract = inGweeod || (userMessage.length >= 10 && !isPureQuestion);
    if (shouldExtract) {
      const priorContext = priorMessages.slice(-EXTRACTION_MESSAGES).filter(({ isBot, botDirected }) => !isBot && !botDirected).map(({ name, text }) => `${name}: ${text}`);
      const triggerLine = (!isPureQuestion && userMessage.length >= 10) ? [`${senderName}: ${userMessage}`] : [];
      const extractionContext = [...priorContext, ...triggerLine].join("\n");
      if (extractionContext.trim()) runImplicitExtraction(extractionContext, requestId, message, inGweeod).catch(() => {});
    }

    if (debugMode) {
      const debugData = {
        directives: directives.map((e) => e.text),
        memories: retrievedMemories.map((e) => e.text),
        person_profile: personProfile ? { person: personProfile.person, memories: personProfile.memories.map((e) => e.text) } : null,
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
