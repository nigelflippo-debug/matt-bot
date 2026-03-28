/**
 * bot.js — Persona Bot Discord bot
 *
 * Responds as the configured persona when mentioned in a Discord channel.
 * Uses the simple pipeline: light retrieval (K=5) + memory-heavy system prompt.
 */

import "dotenv/config";
import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { retrieve, windowSearch } from "../rag/retrieve.js";
import { generate, buildSystemPrompt } from "../rag/generate.js";
import { extractImplicit, detectTemporalExpiry } from "../rag/memory-store.js";
import { publishInferredMemory, publishEntityBackfill } from "../rag/queue-client.js";
import { retrieveMemory, getDirectives, getAllMemory, addMemory, removeMemory } from "../rag/memory-store-pg.js";
import { logPersonaMessage, embedPendingDiscord, retrieveDiscord } from "../rag/discord-log.js";
import { loadEncryptedText } from "../rag/crypto-utils.js";
import { readUrl } from "../rag/url-reader.js";
import { classifyAggression } from "../rag/aggression.js";
import { classifyBit } from "../rag/bit-detection.js";
import { initAffinity, scoreMessage, getDelayMs } from "../rag/topic-affinity.js";
import { getPersona } from "../persona/loader.js";
import { getRedis } from "../rag/redis-client.js";

const persona = getPersona();

const baseSystemPrompt = loadEncryptedText(
  persona.systemPromptEnc,
  persona.systemPromptMd,
);

// How many recent messages to fetch total
const FETCH_MESSAGES = 8;
// How many prior messages to pass to implicit extraction
const EXTRACTION_MESSAGES = 7;

// Passive observation — extract from non-home channels without being mentioned
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

const DEFAULT_REMEMBER_ACKS = {
  added:   ["got it", "noted", "yeah ok", "ok", "yep", "alright", "done", "locked in"],
  merged:  ["yeah I kind of already knew that", "I already had something like that, updated", "already had that one more or less", "merged with what I already had"],
  skipped: ["I already know that", "yeah I know", "already got that one", "I know I know"],
  split:   ["ok I split that — part goes in memory, part is a rule", "treated part of that as a rule and part as memory"],
};

const DEFAULT_REMEMBER_NOW_ACKS = {
  added:   ["got it, won't hold onto that forever", "ok, just for now", "noted, I'll forget it eventually", "yeah ok, temporarily"],
  merged:  ["already had something like that, updated the timing", "I know, updated"],
  skipped: ["already got that", "yeah I know"],
};

const DEFAULT_REMEMBER_BACKOFF = [
  "ok I get it, stop telling me things",
  "my brain is full, come back later",
  "you're going to break me",
  "dude I can't take in any more right now",
  "ok enough, I need a minute",
  "relax, I'll remember stuff",
];

const mp = persona.memoryPhrases;
const REMEMBER_ACKS = mp?.acks ?? DEFAULT_REMEMBER_ACKS;
const REMEMBER_NOW_ACKS = mp?.nowAcks ?? DEFAULT_REMEMBER_NOW_ACKS;
const REMEMBER_BACKOFF = mp?.backoff ?? DEFAULT_REMEMBER_BACKOFF;

// Home channel response rate — don't respond to every unprompted message
const HOME_CHANNEL_RESPONSE_CHANCE = 0.8;
// Pile-on chance — if another bot already claimed this message, respond anyway this often.
// Emojis losing bots may react with instead of silently doing nothing
const LOSE_REACTIONS = ["💀", "😭", "👀", "😂", "💯", "🫡", "🗿", "🤡", "💩", "🥴", "🫠", "😤", "🤌", "🙄", "😮‍💨", "🤦", "🫵", "😵", "🤙", "👁️"];

// Bot cross-talk — when a bot posts, other bots may respond to it.
// Redis claiming (below) prevents fan-out; this controls base engagement rate.
const BOT_RESPONSE_CHANCE = 0.25;

// Aggression state — per-channel tracking of provocation-triggered aggressive mode
const aggressionState = new Map(); // channelId → {topic, remainingReplies}

function getAggression(channelId) {
  const state = aggressionState.get(channelId);
  if (!state || state.remainingReplies <= 0) {
    aggressionState.delete(channelId);
    return null;
  }
  return state;
}

function triggerAggression(channelId, topic) {
  const replies = Math.random() < 0.5 ? 4 : 5;
  aggressionState.set(channelId, { topic, remainingReplies: replies });
}

function decrementAggression(channelId) {
  const state = aggressionState.get(channelId);
  if (!state) return;
  state.remainingReplies--;
  if (state.remainingReplies <= 0) aggressionState.delete(channelId);
}

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

async function runImplicitExtraction(conversationContext, requestId, message) {
  try {
    const facts = await extractImplicit(conversationContext);
    log(requestId, "implicit_extract", { found: facts.length, facts: facts.map((f) => f.text.slice(0, 60)) });
    if (facts.length === 0) return;

    await publishInferredMemory(persona.id, facts, requestId);
    log(requestId, "implicit_queued", { count: facts.length });

    await message.react("🧠").catch(() => {});
    const anyTemporal = facts.some((f) => detectTemporalExpiry(f.text) !== null);
    if (anyTemporal) await message.react("📅").catch(() => {});

  } catch (err) {
    log(requestId, "implicit_error", { message: err.message });
  }
}

function log(requestId, stage, data = {}) {
  const entry = { ts: new Date().toISOString(), requestId, stage, ...data };
  console.log(JSON.stringify(entry));
}

const injectionConfig = persona.specialBehaviors.injection ?? {};
const INJECTION_SEED = injectionConfig.seed ?? "";
const INJECTION_MIN_MS = injectionConfig.minMs ?? 4 * 60 * 60 * 1000;
const INJECTION_MAX_MS = injectionConfig.maxMs ?? 8 * 60 * 60 * 1000;

function randomInjectionDelay() {
  return INJECTION_MIN_MS + Math.random() * (INJECTION_MAX_MS - INJECTION_MIN_MS);
}

const chippleConfig = persona.specialBehaviors.chipple ?? {};
const CHIPPLE_SEEDS = chippleConfig.seeds ?? [];
const CHIPPLE_OPENERS = chippleConfig.openers ?? [];
const CHIPPLE_CLOSERS = chippleConfig.closers ?? [];

async function runChippleMeltdown(channel) {
  try {
    const seed = CHIPPLE_SEEDS[Math.floor(Math.random() * CHIPPLE_SEEDS.length)];
    const opener = CHIPPLE_OPENERS[Math.floor(Math.random() * CHIPPLE_OPENERS.length)];
    const closer = CHIPPLE_CLOSERS[Math.floor(Math.random() * CHIPPLE_CLOSERS.length)];

    const [results, contextWindows] = await Promise.all([
      retrieve(seed, 5, "", recentExampleIds),
      windowSearch(seed, 3, 4, persona.nameVariants),
    ]);
    const [memoryResult, directives] = await Promise.all([
      retrieveMemory(seed, 8),
      Promise.resolve(getDirectives()),
    ]);
    const { memories: retrievedMemories, personProfile } = memoryResult;
    const systemPrompt = buildSystemPrompt(baseSystemPrompt, results, contextWindows, [], retrievedMemories, directives, [], personProfile, null, persona.name);

    // Send three messages with typing breaks for dramatic effect
    await channel.sendTyping();
    await new Promise((r) => setTimeout(r, 1500));
    await channel.send(opener);

    await channel.sendTyping();
    await new Promise((r) => setTimeout(r, 3000));
    const breakdown = await generate(systemPrompt, [], seed);
    await channel.send(breakdown);

    await channel.sendTyping();
    await new Promise((r) => setTimeout(r, 2000));
    await channel.send(closer);

    log("chipple", "meltdown_sent", { preview: breakdown.slice(0, 80) });
  } catch (err) {
    log("chipple", "meltdown_error", { message: err.message });
  }
}

async function runInjection() {
  const injectionId = `inj_${Date.now().toString(36)}`;
  log(injectionId, "injection_start");

  const channels = [];
  for (const guild of client.guilds.cache.values()) {
    const ch = guild.channels.cache.find((c) => c.name === persona.homeChannel && c.isTextBased());
    if (ch) channels.push(ch);
  }

  if (channels.length === 0) {
    log(injectionId, "injection_skip", { reason: `no ${persona.homeChannel} channel found` });
    return;
  }

  try {
    const [results, contextWindows] = await Promise.all([
      retrieve(INJECTION_SEED, 5, "", recentExampleIds),
      windowSearch(INJECTION_SEED, 3, 4, persona.nameVariants),
    ]);
    trackExamples(results.map((r) => r.id));

    const [memoryResult, directives, discordExamples] = await Promise.all([
      retrieveMemory(INJECTION_SEED, 8),
      Promise.resolve(getDirectives()),
      retrieveDiscord(INJECTION_SEED, 3),
    ]);
    const { memories: retrievedMemories, personProfile } = memoryResult;

    const systemPrompt = buildSystemPrompt(baseSystemPrompt, results, contextWindows, [], retrievedMemories, directives, discordExamples, personProfile, null, persona.name);
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
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "ready", tag: c.user.tag, persona: persona.id }));
  // Derive topic keywords from system prompt for claim delay routing
  initAffinity(baseSystemPrompt, persona.nameVariants ?? []).catch(() => {});

  if (injectionConfig.enabled) scheduleInjection();

  // Backfill entity summaries for any entities without one yet (idempotent)
  publishEntityBackfill(persona.id).catch(() => {});
});

// Discord connection lifecycle events — log for diagnosing silent downtime
client.on(Events.ShardDisconnect, (event, shardId) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "shard_disconnect", shardId, code: event.code }));
});

client.on(Events.ShardReconnecting, (shardId) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "shard_reconnecting", shardId }));
});

client.on(Events.ShardResume, (shardId, replayedEvents) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "shard_resume", shardId, replayedEvents }));
});

client.on(Events.ShardError, (error, shardId) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "shard_error", shardId, message: error.message }));
});

// Unhandled promise rejections — catch anything that escapes normal error handling
process.on("unhandledRejection", (reason) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "unhandled_rejection", message: String(reason?.message ?? reason), stack: reason?.stack }));
});

client.on(Events.MessageCreate, async (message) => {
  // Determine home channel early — needed for bit state before bot-message gating
  const inHomeChannel = message.channel.name === persona.homeChannel;

  // Read active bit state from Redis (needed for depth-limit relaxation below)
  let activeBit = null;
  if (inHomeChannel) {
    const redis = getRedis();
    if (redis) {
      try {
        const data = await redis.hgetall(`bit:channel:${message.channel.id}`);
        if (data && data.step) activeBit = data;
      } catch {}
    }
  }

  // Human interrupt — any human message in home channel kills an active bit
  if (!message.author.bot && inHomeChannel) {
    const redis = getRedis();
    if (redis) redis.del(`bit:channel:${message.channel.id}`).catch(() => {});
    activeBit = null;
  }

  if (message.author.bot) {
    // Never respond to ourselves
    if (message.author.id === client.user?.id) return;
    // Outside home channel: ignore all bots
    if (!inHomeChannel) return;
    // Depth limit — if this bot message is itself a reply to another bot, bail.
    // Exception: during an active bit, allow deeper chains (decay math gates the response).
    if (message.reference?.messageId) {
      try {
        const parent = await message.channel.messages.fetch(message.reference.messageId);
        if (parent.author.bot && !activeBit) return;
      } catch {
        // If we can't fetch the parent, bail to be safe
        return;
      }
    }
    // Bit decay math replaces flat BOT_RESPONSE_CHANCE during active bits
    if (activeBit) {
      const step = parseInt(activeBit.step, 10);
      if (step >= 6) {
        const redis = getRedis();
        if (redis) redis.del(`bit:channel:${message.channel.id}`).catch(() => {});
        return;
      }
      const p = 0.85 * Math.pow(0.45, step - 1);
      if (Math.random() >= p) {
        log(message.id.slice(-6), "bit_decay_bail", { step, p: p.toFixed(3) });
        return;
      }
    } else {
      // No active bit — 25% chance to respond to a bot message
      if (Math.random() >= BOT_RESPONSE_CHANCE) return;
    }
    // Fall through — respond to this bot message
  }

  // Spam check — runs on every human message regardless of channel or mention
  if (!message.author.bot) await checkSpam(message);

  // Sleeper word — "chipple/chipples" triggers a full meltdown (persona-specific)
  if (chippleConfig.enabled && /\bchipples?\b/i.test(message.content)) {
    runChippleMeltdown(message.channel).catch(() => {});
    return;
  }
  const botMentioned = message.mentions.has(client.user);
  const onlyOthersMentioned = message.mentions.users.size > 0 && !botMentioned;

  // Passive observation — accumulate messages in non-home channel channels for extraction
  if (!inHomeChannel) {
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
      }
    }
  }

  // If someone else is tagged (and not the bot), stay out of it
  // Skip this check for bot messages — reply mentions don't count as "someone else tagged"
  if (!message.author.bot && onlyOthersMentioned) return;
  // Outside home channel, only respond when explicitly mentioned
  if (!inHomeChannel && !botMentioned) return;
  // Redis coordination — atomic claim so only one bot responds per message.
  // Covers both human and bot messages — prevents fan-out in cross-talk chains.
  // Falls back gracefully if Redis is unavailable.
  if (inHomeChannel && !botMentioned) {
    const redis = getRedis();
    if (redis) {
      try {
        // 1. Topic routing — delay before claiming so high-affinity bots win the race
        //    Skip during active bits — decay math already gated the response
        let affinityScore = 0;
        if (!activeBit && !message.author.bot) {
          affinityScore = scoreMessage(message.content);
          const delay = getDelayMs(affinityScore);
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          log(message.id.slice(-6), "coord_affinity", { score: affinityScore.toFixed(3), delayMs: delay });
        }

        // 2. Atomic claim — first bot wins; losers pile on if topic matches, otherwise bail
        const claimed = await redis.set(`coord:msg:${message.id}`, persona.id, "NX", "EX", 30);
        if (!claimed) {
          // High-affinity losers get a pile-on chance — topic overlaps multiple personas
          const pileOnChance = getDelayMs(affinityScore) === 0 ? 0.5 : 0;
          if (Math.random() >= pileOnChance) {
            if (Math.random() < 0.2) message.react(LOSE_REACTIONS[Math.floor(Math.random() * LOSE_REACTIONS.length)]).catch(() => {});
            return;
          }
        }
        log(message.id.slice(-6), "coord_claim", { won: true });

        // 3. Winner rolls response chance — skip during bits (decay already gated)
        if (!activeBit && !message.author.bot && Math.random() >= HOME_CHANNEL_RESPONSE_CHANCE) return;
      } catch (err) {
        log(message.id.slice(-6), "coord_error", { message: err.message });
      }
    } else {
      // No Redis — fall back to local response chance roll
      if (inHomeChannel && !botMentioned && !message.author.bot && Math.random() >= HOME_CHANNEL_RESPONSE_CHANCE) return;
    }
  }

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

  // Handle "remember: X" and "remember for now: X" — store a memory entry and acknowledge
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
      const result = await addMemory(`for now: ${fact}`, senderName);
      log(requestId, "memory_write", { fact, addedBy: senderName, action: result.action, path: "temporary" });
      const pool = REMEMBER_NOW_ACKS[result.action] ?? ["ok"];
      await message.reply(pool[Math.floor(Math.random() * pool.length)]);
      const reacts = { added: "📅", merged: "✏️", skipped: "👍", split: "✂️" };
      const emoji = reacts[result.action];
      if (emoji) await message.react(emoji).catch(() => {});
    } else {
      // "remember:" from any user — permanent memory
      const result = await addMemory(fact, senderName);
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

  // Handle "list memory" — send all memory entries as a JSON file attachment
  if (/^list memory$/i.test(userMessage)) {
    const entries = await getAllMemory();
    if (entries.length === 0) {
      await message.reply(`No memories stored yet.`);
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
      files: [{ attachment: buf, name: "memory.json" }],
    });
    return;
  }

  // Handle "forget: X" — remove memory entries matching a keyword
  const forgetMatch = userMessage.match(/^forget:\s*(.+)/i);
  if (forgetMatch) {
    if (!isAdmin(message.author.id)) {
      await message.reply(`nah`);
      return;
    }
    const keyword = forgetMatch[1].trim();
    const { removed, entries: removedEntries } = await removeMemory(keyword);
    log(requestId, "lore_removed", { keyword, removed });
    if (removed === 0) {
      await message.reply(`I don't have anything about that.`);
    } else {
      const list = removedEntries.map((e) => `• [${e.category}] ${e.text}`).join("\n");
      await message.reply(`Forgotten ${removed} thing${removed === 1 ? "" : "s"}:\n${list}`);
    }
    return;
  }

  // Handle "read: <url>" — fetch a URL and extract facts into memory (admin only)
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

      // Store each fact as a permanent memory entry
      let added = 0;
      let skipped = 0;
      const sampleFacts = [];

      for (const fact of facts) {
        const result = await addMemory(fact, senderName, { source: "url-import", sourceUrl: url });
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

    } catch (err) {
      clearInterval(typingInterval);
      log(requestId, "url_read_error", { url, message: err.message });
      await message.reply(`Something went wrong reading that page.`);
    }
    return;
  }

  let typingInterval;
  try {
    await message.channel.sendTyping();
    typingInterval = setInterval(() => message.channel.sendTyping(), 8000);
    const t0 = Date.now();

    // Fetch recent channel messages
    const recent = await message.channel.messages.fetch({ limit: FETCH_MESSAGES + 1 });
    const priorMessages = [...recent.values()]
      .filter((m) => m.id !== message.id)
      .reverse()
      .map((m) => {
        const isBot = m.author.bot;
        const name = isBot ? persona.name : m.member?.displayName ?? m.author.username;
        const text = m.content.replace(/<@!?\d+>/g, "").trim();
        const botDirected = m.mentions.has(client.user);
        return { isBot, name, text, botDirected };
      })
      .filter(({ text }) => text.length > 0);

    log(requestId, "context_fetched", { priorMessageCount: priorMessages.length });

    // If this is the real person posting (not the bot, not directed at the bot), log the exchange as training data
    const realPersonDiscordId = persona.discordUserId;
    if (realPersonDiscordId && message.author.id === realPersonDiscordId && userMessage && !message.mentions.has(client.user)) {
      const contextWindow = priorMessages
        .slice(-3)
        .map(({ name, text }) => `${name}: ${text}`)
        .join("\n");
      logPersonaMessage(contextWindow, `${persona.name}: ${userMessage}`);
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
    const [results, contextWindows, aggressionClassification, bitClassification] = await Promise.all([
      retrieve(retrievalQuery, 5, conversationContext, recentExampleIds),
      windowSearch(retrievalQuery, 3, 4, persona.nameVariants),
      classifyAggression(userMessage, conversationContext, persona.aggressionTopics ?? []),
      message.author.bot && !activeBit
        ? classifyBit(userMessage, conversationContext)
        : Promise.resolve({ isBit: false, hook: null }),
    ]);
    trackExamples(results.map((r) => r.id));
    const t2 = Date.now();

    // Update aggression state based on classification
    if (aggressionClassification.triggered) {
      triggerAggression(message.channel.id, aggressionClassification.topic);
      log(requestId, "aggression_triggered", { topic: aggressionClassification.topic });
    }
    const aggression = getAggression(message.channel.id);

    // Bit state — join existing bit or start a new one
    let bitContext = null;
    try {
      const redis = getRedis();
      if (activeBit && redis) {
        // Join existing bit — increment step
        await redis.hincrby(`bit:channel:${message.channel.id}`, "step", 1);
        const participants = activeBit.participants || "";
        if (!participants.split(",").includes(persona.id)) {
          await redis.hset(`bit:channel:${message.channel.id}`, "participants", participants + "," + persona.id);
        }
        bitContext = { hook: activeBit.topic, step: parseInt(activeBit.step, 10) + 1 };
        log(requestId, "bit_joined", { hook: bitContext.hook, step: bitContext.step });
      } else if (bitClassification.isBit && redis) {
        // Start new bit — HSETNX as atomic creation gate
        const created = await redis.hsetnx(`bit:channel:${message.channel.id}`, "step", "1");
        if (created) {
          await redis.hmset(`bit:channel:${message.channel.id}`, {
            topic: bitClassification.hook,
            originMessageId: message.id,
            originBotId: message.author.id,
            participants: persona.id,
            startedAt: Date.now().toString(),
          });
          await redis.expire(`bit:channel:${message.channel.id}`, 120);
          bitContext = { hook: bitClassification.hook, step: 1 };
        } else {
          // Another bot beat us — read the existing state and join
          const existing = await redis.hgetall(`bit:channel:${message.channel.id}`);
          if (existing?.topic) {
            await redis.hincrby(`bit:channel:${message.channel.id}`, "step", 1);
            bitContext = { hook: existing.topic, step: parseInt(existing.step, 10) + 1 };
          }
        }
        if (bitContext) log(requestId, "bit_started", { hook: bitContext.hook, step: bitContext.step });
      }
    } catch (err) {
      log(requestId, "bit_state_error", { message: err.message });
    }

    log(requestId, "retrieval_complete", {
      ragResults: results.length,
      contextWindows: contextWindows.length,
      ms: t2 - t1,
    });

    // Retrieve relevant memories + directives + discord examples
    const [memoryResult, directives, discordExamples] = await Promise.all([
      retrieveMemory(retrievalQuery, 8),
      Promise.resolve(getDirectives()),
      retrieveDiscord(retrievalQuery, 3),
    ]);
    const { memories: retrievedMemories, personProfile } = memoryResult;
    log(requestId, "memory_retrieved", { memories: retrievedMemories.length, profile: personProfile?.person ?? null, directives: directives.length, discordExamples: discordExamples.length });

    // Extract the last few bot replies to discourage repetition
    const recentBotReplies = history
      .filter((m) => m.role === "assistant")
      .slice(-3)
      .map((m) => m.content);

    const crossTalkHint = message.author.bot
      ? `${senderName} just said something to you directly. This is a back-and-forth — engage with what they actually said. Respond to the specific thing, push back, ask something, keep the thread going. Don't just react to the topic and drop it.`
      : null;

    const systemPrompt = buildSystemPrompt(baseSystemPrompt, results, contextWindows, recentBotReplies, retrievedMemories, directives, discordExamples, personProfile, aggression, persona.name, crossTalkHint, bitContext);

    log(requestId, "generating", { aggressive: !!aggression, bit: !!bitContext });
    const t3 = Date.now();
    const userContent = userMessage ? `${senderName}: ${userMessage}` : `${senderName} sent an image.`;
    const genOverrides = bitContext ? { temperature: 1.0 } : aggression ? { max_tokens: 600, temperature: 1.3 } : {};
    const reply = await generate(systemPrompt, history, userContent, imageUrls, genOverrides);
    const t4 = Date.now();

    log(requestId, "generated", {
      ms: t4 - t3,
      replyPreview: reply.slice(0, 80),
      totalMs: t4 - t0,
    });

    clearInterval(typingInterval);
    await message.reply(reply);
    log(requestId, "replied");

    // Decrement aggression counter after each bot reply (skip during bits — bit takes priority)
    if (aggression && !bitContext) decrementAggression(message.channel.id);

    // Background work — none of this blocks the reply
    embedPendingDiscord().catch(() => {});

    // Implicit extraction — in home channel the bot responds to everything so always extract from context.
    // Outside home channel, skip short pure questions since they contain no facts.
    const isPureQuestion = userMessage.endsWith("?") && userMessage.length < 60;
    const shouldExtract = inHomeChannel || (userMessage.length >= 10 && !isPureQuestion);
    if (shouldExtract) {
      const priorContext = priorMessages.slice(-EXTRACTION_MESSAGES).filter(({ isBot, botDirected }) => !isBot && !botDirected).map(({ name, text }) => `${name}: ${text}`);
      const triggerLine = (!isPureQuestion && userMessage.length >= 10) ? [`${senderName}: ${userMessage}`] : [];
      const extractionContext = [...priorContext, ...triggerLine].join("\n");
      if (extractionContext.trim()) runImplicitExtraction(extractionContext, requestId, message, inHomeChannel).catch(() => {});
    }

    if (debugMode) {
      const debugData = {
        directives: directives.map((e) => e.text),
        memories: retrievedMemories.map((e) => e.text),
        person_profile: personProfile ? { person: personProfile.person, memories: personProfile.memories.map((e) => e.text) } : null,
        corpus_windows: contextWindows.map((w) => w.text),
        discord_examples: discordExamples.map((e) => e.response),
        rag_examples: results.map((r) => r.response),
      };
      const buf = Buffer.from(JSON.stringify(debugData, null, 2), "utf8");
      await message.channel.send({
        content: `**[debug]** directives:${directives.length} facts:${retrievedFacts.length} corpus:${contextWindows.length} discord:${discordExamples.length} rag:${results.length}`,
        files: [{ attachment: buf, name: "debug.json" }],
      });
    }
  } catch (err) {
    clearInterval(typingInterval);
    log(requestId, "error", { message: err.message, stack: err.stack });
  }
});

client.login(process.env.DISCORD_TOKEN);
