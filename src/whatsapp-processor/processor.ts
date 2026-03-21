import * as fs from "fs";
import * as path from "path";

interface Message {
  chat: string;
  timestamp: string; // ISO 8601
  sender: string;
  text: string;
  isMatt: boolean;
  isMedia: boolean;
}

const MATT_NAME = "Matt Guiod";

// Matches: [M/D/YY, H:MM:SS AM/PM] Sender: text
// The leading \u200e (left-to-right mark) is optional
const MESSAGE_START = /^\u200e?\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2}:\d{2}\s[AP]M)\]\s([^:]+):\s?(.*)/;

// System event lines (no sender colon — just a group action)
const SYSTEM_EVENT = /^\u200e?\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2}:\d{2}\s[AP]M)\]\s[^:]+$/;

const MEDIA_PATTERNS = [
  /^\u200e?image omitted$/i,
  /^\u200e?video omitted$/i,
  /^\u200e?audio omitted$/i,
  /^\u200e?sticker omitted$/i,
  /^\u200e?GIF omitted$/i,
  /^\u200e?document omitted$/i,
  /^\u200e?Contact card omitted$/i,
  /^\u200e?voice message omitted$/i,
  /^\u200e?missed voice call$/i,
  /^\u200e?missed video call$/i,
];

const EDIT_SUFFIX = /\s*\u200e?<This message was edited>$/;

const SYSTEM_TEXT_PATTERNS = [
  /^Messages and calls are end-to-end encrypted/i,
  /created this group$/i,
  /added you$/i,
  /added .+ to this group/i,
  / left$/i,
  /changed the subject (from|to)/i,
  /changed this group's icon/i,
  /changed their phone number/i,
  /You were added/i,
  /was added$/i,
  /removed .*from this group/i,
  /^This message was deleted$/i,
  /^You deleted this message$/i,
];

function isSystemMessage(text: string): boolean {
  return SYSTEM_TEXT_PATTERNS.some((p) => p.test(text));
}

function isMediaOnly(text: string): boolean {
  return MEDIA_PATTERNS.some((p) => p.test(text.trim()));
}

function cleanText(text: string): string {
  // Strip <This message was edited> suffix
  text = text.replace(EDIT_SUFFIX, "");
  // Strip leading/trailing left-to-right marks and zero-width spaces
  text = text.replace(/^\u200e+/, "").replace(/\u200e+$/, "");
  return text.trim();
}

function parseTimestamp(date: string, time: string): string {
  // date: M/D/YY or M/D/YYYY  time: H:MM:SS AM/PM
  const [month, day, year] = date.split("/").map(Number);
  const fullYear = year < 100 ? 2000 + year : year;
  const [timePart, meridiem] = time.split(/\s+/);
  let [hours, minutes, seconds] = timePart.split(":").map(Number);
  if (meridiem === "PM" && hours !== 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;
  const d = new Date(fullYear, month - 1, day, hours, minutes, seconds);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: date="${date}" time="${time}" → ${fullYear}-${month}-${day} ${hours}:${minutes}:${seconds}`);
  }
  return d.toISOString();
}

function parseChat(filePath: string, chatSlug: string): Message[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""));

  const messages: Message[] = [];
  let current: {
    date: string;
    time: string;
    sender: string;
    textLines: string[];
  } | null = null;

  function flush() {
    if (!current) return;
    const rawText = current.textLines.join("\n");
    const text = cleanText(rawText);
    const sender = current.sender.trim();

    // Skip system event messages and empty messages
    if (isSystemMessage(text) || text === "") {
      current = null;
      return;
    }

    messages.push({
      chat: chatSlug,
      timestamp: parseTimestamp(current.date, current.time),
      sender,
      text,
      isMatt: sender === MATT_NAME,
      isMedia: isMediaOnly(text),
    });
    current = null;
  }

  for (const line of lines) {
    const match = line.match(MESSAGE_START);
    if (match) {
      flush();
      const [, date, time, sender, firstLine] = match;
      current = { date, time, sender, textLines: [firstLine] };
    } else if (SYSTEM_EVENT.test(line)) {
      // Group action with no message body — skip
      flush();
    } else if (current) {
      // Continuation of previous message
      current.textLines.push(line);
    }
    // Lines before any message start are ignored
  }
  flush();

  return messages;
}

function main() {
  const chatDataDir = path.resolve(__dirname, "../../chat-data");
  const outputDir = path.resolve(__dirname, "../../data");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "corpus.json");

  const chatFiles: { file: string; slug: string }[] = [
    { file: "_chat_mc.txt", slug: "mc" },
    { file: "_chat_gamer.txt", slug: "gamer" },
    { file: "_chat_os.txt", slug: "os" },
  ];

  let all: Message[] = [];

  for (const { file, slug } of chatFiles) {
    const filePath = path.join(chatDataDir, file);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    const messages = parseChat(filePath, slug);
    console.log(`  ${slug}: ${messages.length} messages (${messages.filter((m) => m.isMatt).length} from Matt)`);
    all = all.concat(messages);
  }

  // Sort by timestamp
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  fs.writeFileSync(outputPath, JSON.stringify(all, null, 2), "utf-8");

  const mattCount = all.filter((m) => m.isMatt).length;
  const mediaCount = all.filter((m) => m.isMedia).length;
  console.log(`\nTotal: ${all.length} messages`);
  console.log(`  Matt's messages: ${mattCount}`);
  console.log(`  Media-only: ${mediaCount}`);
  console.log(`\nOutput: ${outputPath}`);
}

main();
