import { tool } from "ai";
import { execa } from "execa";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { WORKSPACE_DIR } from "../config";
import { MAX_OUTPUT, tailTruncate } from "./util";

const DEFAULT_TIMEOUT = 120; // seconds
const MAX_TIMEOUT = 600; // seconds
const SPILL_DIR = join(tmpdir(), "harry-bash"); // full output spills here, off the memory repo

// Cap one stream: keep the tail; if it overflowed, write the full text to a temp
// file and prepend a note pointing the agent at it (readable via readFile or bash).
const capStream = async (
  stream: "stdout" | "stderr",
  text: string,
): Promise<string> => {
  const { text: tail, omitted } = tailTruncate(text);
  if (omitted === 0) return text;
  await mkdir(SPILL_DIR, { recursive: true });
  const file = join(SPILL_DIR, `${randomUUID()}.${stream}.txt`);
  await writeFile(file, text);
  return `…[${omitted} earlier chars truncated — full ${stream} saved to ${file}; read it with readFile or grep it with bash]…\n${tail}`;
};

export const bash = tool({
  description:
    "Run a bash command on your computer (working dir = your home; your memory lives in ./memory). Returns stdout, stderr, exitCode; a non-zero exit is returned, not thrown. " +
    `Output keeps the last ~${MAX_OUTPUT / 1000}k chars per stream; anything longer is saved to a temp file whose path is included. ` +
    `Default timeout ${DEFAULT_TIMEOUT}s (max ${MAX_TIMEOUT}s).`,
  inputSchema: z.object({
    command: z.string().describe("The bash command to run."),
    timeout: z
      .number()
      .optional()
      .describe(`Timeout in seconds (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}).`),
  }),
  execute: async ({ command, timeout }) => {
    const secs = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const r = await execa("bash", ["-lc", command], {
      cwd: WORKSPACE_DIR,
      timeout: secs * 1000,
      reject: false,
      maxBuffer: 50_000_000,
    });
    return {
      stdout: await capStream("stdout", r.stdout ?? ""),
      stderr: await capStream("stderr", r.stderr ?? ""),
      exitCode: r.exitCode ?? (r.timedOut ? 124 : 1),
      ...(r.timedOut && {
        timedOut: true,
        note: `Command exceeded the ${secs}s timeout and was killed.`,
      }),
    };
  },
});
