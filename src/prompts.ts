import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMORY_DIR } from "./config";

const AGENTS = readFileSync(
  join(import.meta.dirname, "AGENTS.md"),
  "utf8",
).trim();

const memoryFile = join(MEMORY_DIR, "MEMORY.md");

const readMemory = async (): Promise<string> => {
  try {
    const content = (await readFile(memoryFile, "utf8")).trim();
    if (!content) return "";
    return `\n## MEMORY.md — your always-loaded memory
The contents of memory/MEMORY.md, injected here automatically every turn. Keep it current: store durable facts about the user and yourself here so you always have them without searching.

${content}\n`;
  } catch {
    return ""; // no MEMORY.md yet — fine
  }
};

export const buildSystemPrompt = async () =>
  `${AGENTS}\n${await readMemory()}\nThe current date and time is ${new Date().toString()}\n`;

export const REMINDER_PROMPT =
  "[REMINDER] This is a reminder you scheduled yourself to carry out a request from the user:";
