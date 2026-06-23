import { tool } from "ai";
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { WORKSPACE_DIR } from "../config";
import { truncate } from "./util";

export const readFile = tool({
  description: "Read a file (path relative to your home directory; memory lives in ./memory).",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    try {
      return { content: truncate(await fsReadFile(resolve(WORKSPACE_DIR, path), "utf8")) };
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
    const full = resolve(WORKSPACE_DIR, path);
    await mkdir(dirname(full), { recursive: true });
    await fsWriteFile(full, content);
    return { ok: true, path };
  },
});
