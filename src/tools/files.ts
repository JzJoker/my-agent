import { tool } from "ai";
import {
  mkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { WORKSPACE_ROOT } from "../config";

export const MAX_OUTPUT = 30_000; // cap tool output so it doesn't blow the context window

// Middle-truncate
export const truncate = (s: string) => {
  if (s.length <= MAX_OUTPUT) return s;
  return `${s.slice(0, MAX_OUTPUT / 2)}\n…[truncated ${s.length - MAX_OUTPUT} chars]…\n${s.slice(-MAX_OUTPUT / 2)}`;
};

// Tail-truncate
export const tailTruncate = (s: string): { text: string; omitted: number } =>
  s.length <= MAX_OUTPUT
    ? { text: s, omitted: 0 }
    : { text: s.slice(s.length - MAX_OUTPUT), omitted: s.length - MAX_OUTPUT };

export const readFile = tool({
  description:
    "Read a file (path relative to your home directory; memory lives in ./memory).",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    try {
      const full_path = resolve(WORKSPACE_ROOT, path);
      const raw_content = await fsReadFile(full_path, "utf8");
      return { content: raw_content };
    } catch (e: any) {
      return { error: e?.message ?? String(e) };
    }
  },
});

export const writeFile = tool({
  description:
    "Write (overwrite) a file, path relative to your home directory (memory lives in ./memory). Prefer this over bash heredocs for multi-line content.",
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  execute: async ({ path, content }) => {
    const full = resolve(WORKSPACE_ROOT, path);
    await mkdir(dirname(full), { recursive: true });
    await fsWriteFile(full, content);
    return { ok: true, path };
  },
});
