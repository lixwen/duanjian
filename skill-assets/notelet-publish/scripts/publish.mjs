#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  DEFAULT_ORIGIN,
  DEFAULT_TTL,
  publishCodexThread,
  publishConversation,
  publishMarkdownFile,
} from "./duanjian.mjs";

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error("Usage: node publish.mjs (--thread-id <id> | --current-task | --conversation <json> | --file <md>) [--ttl 1h|1d|7d|30d|1y|never] [--title <title>] [--slug <slug>] [--include-current-turn] [--origin <url>] [--dry-run]");
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { ttl: DEFAULT_TTL, origin: DEFAULT_ORIGIN, dryRun: false, excludeLastTurn: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") { options.dryRun = true; continue; }
    if (argument === "--current-task") { options.currentTask = true; continue; }
    if (argument === "--include-current-turn") { options.excludeLastTurn = false; continue; }
    if (!argument.startsWith("--")) return { error: `Unexpected argument: ${argument}` };
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) return { error: `Missing value for --${key}` };
    index += 1;
    const normalized = key === "thread-id" ? "threadId" : key;
    if (["file", "conversation", "threadId", "title", "author", "ttl", "slug", "origin", "endpoint"].includes(normalized)) options[normalized] = value;
    else return { error: `Unknown option: --${key}` };
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.error) return usage(options.error);
  const modes = [options.file, options.conversation, options.threadId, options.currentTask].filter(Boolean);
  if (modes.length !== 1) return usage("Choose exactly one input mode");
  let result;
  if (options.file) result = await publishMarkdownFile(options);
  else if (options.conversation) result = await publishConversation(JSON.parse(await readFile(options.conversation, "utf8")), options);
  else result = await publishCodexThread(options);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
