import { Tool, tool, type ToolSet } from "ai";
import { resolve } from "node:path";
import { z } from "zod";
import { WORKSPACE_ROOT } from "../config";
import { bash } from "./bash";
import { getComposioTools } from "./composio";
import { readFile, writeFile } from "./files";
import { check_print } from "./printer";
import { web_extract, web_search } from "./web";

export type MyAgentTools = ToolSet & {
  send_file: Tool<any, any, { sendFile: SendFile }>;
};

export type SendFile = (
  absolutePath: string,
  caption?: string,
) => Promise<void>;

export const coreTools: MyAgentTools = {
  bash,
  readFile,
  writeFile,
  web_search,
  web_extract,
  check_print,
  send_file: tool({
    description:
      "Send a file from your workspace to the user in the chat — a chart/image (PNG, JPG), a CSV, a PDF, etc. Path is relative to your home directory; optional short caption.",
    inputSchema: z.object({ path: z.string(), caption: z.string().optional() }),
    contextSchema: z.custom<{ sendFile: SendFile }>(),
    execute: async ({ path, caption }, { context }) => {
      try {
        await context.sendFile(resolve(WORKSPACE_ROOT, path), caption);
        return { ok: true };
      } catch (e: any) {
        return { error: e?.message ?? String(e) };
      }
    },
  }),
  list_tools: tool({
    description:
      "Reveal your extra tools. Call this when a request needs something your core tools can't do, then call the tool you need.",
    inputSchema: z.object({}),
    execute: async () =>
      Object.entries<any>(extraTools)
        .map(([name, t]) => `- ${name}: ${t.description ?? ""}`)
        .join("\n") || "No extra tools available.",
  }),
};

const extraTools = await getComposioTools();
export const tools: MyAgentTools = { ...coreTools, ...extraTools };
