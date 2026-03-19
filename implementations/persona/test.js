import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import readline from "readline";

const systemPrompt = fs.readFileSync(
  new URL("./system-prompt.md", import.meta.url),
  "utf8"
);

const client = new Anthropic();
const history = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("Matt Bot test — type your messages, Ctrl+C to quit\n");

function ask() {
  rl.question("You: ", async (input) => {
    input = input.trim();
    if (!input) return ask();

    history.push({ role: "user", content: input });

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: systemPrompt,
      messages: history,
    });

    const reply = response.content[0].text;
    history.push({ role: "assistant", content: reply });
    console.log(`Matt: ${reply}\n`);
    ask();
  });
}

ask();
