/**
 * test.js — simple version
 *
 * Lore-heavy system prompt + light style retrieval (K=5, no query enrichment).
 * No lore search injection — lore lives in the prompt.
 * Compare side-by-side with implementations/rag/test.js.
 */

import "dotenv/config";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { retrieve, loreSearch } from "../rag/retrieve.js";
import { generate, buildSystemPrompt } from "../rag/generate.js";
import { loadEncryptedText } from "../rag/crypto-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG = process.argv.includes("--debug");

const baseSystemPrompt = loadEncryptedText(
  path.resolve(__dirname, "./system-prompt.enc"),
  path.resolve(__dirname, "./system-prompt.md"),
);

const history = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log(
  `Matt Bot (simple)${DEBUG ? " [debug]" : ""} — type your messages, Ctrl+C to quit\n`
);

async function ask() {
  rl.question("You: ", async (input) => {
    input = input.trim();
    if (!input) return ask();

    const [results, loreWindows] = await Promise.all([
      retrieve(input, 5),
      loreSearch(input, 3),
    ]);

    if (DEBUG) {
      console.log("[retrieved examples]");
      results.forEach(({ inputContext, response, responseType, lengthBucket, timestamp }, i) => {
        const ctx = inputContext ? `\n${inputContext.split("\n").map((l) => `  ${l}`).join("\n")}` : "";
        console.log(
          `\n  ${i + 1}. [${responseType} / ${lengthBucket} / ${timestamp.slice(0, 10)}]${ctx}\n  ${response}`
        );
      });
      if (loreWindows.length > 0) {
        console.log("\n[lore windows]");
        loreWindows.forEach((w, i) => console.log(`\n  ${i + 1}. [${w.chat}]\n${w.text.split("\n").map(l => `    ${l}`).join("\n")}`));
      }
      console.log();
    }

    const recentBotReplies = history
      .filter((m) => m.role === "assistant")
      .slice(-3)
      .map((m) => m.content);

    const systemPrompt = buildSystemPrompt(baseSystemPrompt, results, loreWindows, recentBotReplies);
    const reply = await generate(systemPrompt, history, input);
    history.push({ role: "user", content: input });
    history.push({ role: "assistant", content: reply });
    console.log(`Matt: ${reply}\n`);
    ask();
  });
}

ask();
