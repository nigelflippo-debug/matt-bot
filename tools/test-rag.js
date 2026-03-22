import "dotenv/config";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { retrieve, enrichQuery, loreSearch } from "../src/rag/retrieve.js";
import { generate, buildSystemPrompt } from "../src/rag/generate.js";
import { loadEncryptedText } from "../src/rag/crypto-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG = process.argv.includes("--debug");

const baseSystemPrompt = loadEncryptedText(
  path.resolve(__dirname, "../src/persona/system-prompt.enc"),
  path.resolve(__dirname, "../src/persona/system-prompt.md"),
);

const history = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log(
  `Matt Bot (RAG v2)${DEBUG ? " [debug]" : ""} — type your messages, Ctrl+C to quit\n`
);

async function ask() {
  rl.question("You: ", async (input) => {
    input = input.trim();
    if (!input) return ask();

    // Build conversation context from recent history for retrieval
    const recentContext = history
      .slice(-6)
      .map((m) => (m.role === "user" ? `Friend: ${m.content}` : `Matt: ${m.content}`))
      .join("\n");

    const [results, lore] = await Promise.all([
      retrieve(input, 10, recentContext),
      Promise.resolve(loreSearch(input)),
    ]);

    if (DEBUG) {
      const enriched = await enrichQuery(input, recentContext);
      console.log(`\n[enriched query]\n  ${enriched}\n`);
      if (lore.length > 0) {
        console.log("[lore context]");
        lore.forEach(({ chat, timestamp, text }, i) => {
          console.log(`\n  ${i + 1}. [${chat} / ${timestamp.slice(0, 10)}]`);
          text.split("\n").forEach((l) => console.log(`  ${l}`));
        });
        console.log();
      }
      console.log("[retrieved examples]");
      results.forEach(({ inputContext, response, responseType, lengthBucket, timestamp }, i) => {
        const ctx = inputContext ? `\n${inputContext.split("\n").map((l) => `  ${l}`).join("\n")}` : "";
        console.log(
          `\n  ${i + 1}. [${responseType} / ${lengthBucket} / ${timestamp.slice(0, 10)}]${ctx}\n  ${response}`
        );
      });
      console.log();
    }

    const systemPrompt = buildSystemPrompt(baseSystemPrompt, results, lore);
    const reply = await generate(systemPrompt, history, input);
    history.push({ role: "user", content: input });
    history.push({ role: "assistant", content: reply });
    console.log(`Matt: ${reply}\n`);
    ask();
  });
}

ask();
