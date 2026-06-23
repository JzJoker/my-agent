import { join, resolve } from "node:path";

// The agent's "computer": the working directory for its bash/readFile/writeFile
// tools. Broader than memory — scratch files, cloned repos, etc. can live here too.
export const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR ?? "./workspace");

// The agent's memory: a self-contained, syncable unit inside the workspace.
export const MEMORY_DIR = resolve(
  process.env.MEMORY_DIR ?? join(WORKSPACE_DIR, "memory"),
);
export const conversationsDir = join(MEMORY_DIR, "conversations");
export const notesDir = join(MEMORY_DIR, "notes");
export const remindersDir = join(MEMORY_DIR, "reminders");
