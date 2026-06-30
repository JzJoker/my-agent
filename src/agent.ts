import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "@lmnr-ai/lmnr";
import { isStepCount, tool, ToolLoopAgent } from "ai";
import { Mutex } from "async-mutex";
import { Cron } from "croner";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { remindersDir } from "./config";
import { getConversationHistoryWindow, logMessage } from "./conversations";
import { buildSystemPrompt, REMINDER_PROMPT } from "./prompts";
import { coreTools, MyAgentTools, tools } from "./tools";
import { type CreateAgent, reminderSchema } from "./types";

const moonshot = createOpenAICompatible({
  name: "moonshot",
  baseURL: process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1",
  apiKey: process.env.MOONSHOT_API_KEY,
});
const model = wrapLanguageModel(moonshot(process.env.AGENT_MODEL ?? "kimi-k2.6"));

const revealExtraToolsAfterListTools = ({ steps }: { steps: any[] }) => {
  const calledListTools = steps.some((s) =>
    s.toolCalls.some((c: any) => c.toolName === "list_tools"),
  );
  const active = Object.keys(calledListTools ? tools : coreTools);
  return { activeTools: active };
};

// Appended to the system prompt for voice (HTTP /ask) turns: keep it speakable
// and let the model trigger phone actions.
const VOICE_ADDENDUM =
  "\n\n## Voice mode\nYou are responding by VOICE — your reply is read aloud by text-to-speech. " +
  "Keep it to 1-3 short, natural spoken sentences: no markdown, lists, emojis, or spelled-out URLs. " +
  "To open navigation or a website on the user's phone, CALL the open_maps or open_url tool in addition " +
  "to speaking. For requests like 'directions to my next event', look the detail up with your tools first, " +
  "then call open_maps with the destination.";

// TTS reads punctuation literally, so strip markdown the model may emit.
const toSpeakable = (s: string) =>
  s
    .replace(/\*\*|__|`|~~/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();

export const createAgent: CreateAgent = (deliver, sendFile) => {
  const lock = new Mutex();
  let jobs: Cron[] = [];

  const runTurn = (message: string) =>
    lock.runExclusive(async () => {
      const start = Date.now();
      console.log("turn start");
      try {
        await logMessage("user", message);
        const agent = new ToolLoopAgent<never, MyAgentTools>({
          model,
          tools: tools,
          activeTools: Object.keys(coreTools),
          prepareStep: revealExtraToolsAfterListTools,
          stopWhen: isStepCount(100),
          instructions: await buildSystemPrompt(),
          toolsContext: { send_file: { sendFile }, check_print: { sendFile } },
        });
        const result = await agent.stream({
          messages: await getConversationHistoryWindow(),
        });
        // Forward deltas to the channel while accumulating the full reply to log.
        let reply = "";
        await deliver(
          (async function* () {
            for await (const delta of result.textStream) {
              reply += delta;
              yield delta;
            }
          })(),
        );
        if (reply.trim()) await logMessage("assistant", reply);
      } catch (e: any) {
        console.error("turn failed:", e?.message ?? e);
      }
      await syncReminders();
      console.log(`turn done in ${Date.now() - start}ms`);
    });

  // Voice turn for the HTTP /ask endpoint. Shares the same lock, memory, and
  // reminder scheduler as runTurn, but returns spoken text + phone actions
  // instead of streaming to a chat.
  const ask = (text: string): Promise<{ speak: string; actions: unknown[] }> =>
    lock.runExclusive(async () => {
      const actions: unknown[] = [];
      const open_maps = tool({
        description:
          "Open turn-by-turn navigation to a place on the user's phone. Use for any directions/navigation request.",
        inputSchema: z.object({
          destination: z.string().describe("Address or place name"),
        }),
        execute: async ({ destination }) => {
          actions.push({ type: "open_maps", destination });
          return { ok: true };
        },
      });
      const open_url = tool({
        description: "Open a website / URL on the user's phone.",
        inputSchema: z.object({ url: z.string() }),
        execute: async ({ url }) => {
          actions.push({ type: "open_url", url });
          return { ok: true };
        },
      });
      const voiceCore = { ...coreTools, open_maps, open_url };
      const voiceAll = { ...tools, open_maps, open_url };
      const revealVoiceTools = ({ steps }: { steps: any[] }) => {
        const called = steps.some((s) =>
          s.toolCalls.some((c: any) => c.toolName === "list_tools"),
        );
        return { activeTools: Object.keys(called ? voiceAll : voiceCore) };
      };

      let speak = "";
      try {
        await logMessage("user", text);
        const agent = new ToolLoopAgent({
          model,
          tools: voiceAll,
          activeTools: Object.keys(voiceCore),
          prepareStep: revealVoiceTools,
          stopWhen: isStepCount(100),
          instructions: (await buildSystemPrompt()) + VOICE_ADDENDUM,
          toolsContext: { send_file: { sendFile }, check_print: { sendFile } },
        });
        const result = await agent.stream({
          messages: await getConversationHistoryWindow(),
        });
        for await (const delta of result.textStream) speak += delta;
        if (speak.trim()) await logMessage("assistant", speak);
      } catch (e: any) {
        console.error("ask failed:", e?.message ?? e);
        speak = "Sorry, something went wrong.";
      }
      await syncReminders();
      return { speak: toSpeakable(speak), actions };
    });

  const syncReminders = async () => {
    jobs.forEach((job) => job.stop());
    jobs = [];

    for (const fileName of await readdir(remindersDir)) {
      const path = join(remindersDir, fileName);

      let reminder;
      try {
        reminder = reminderSchema.parse(
          parseYaml(await readFile(path, "utf8")),
        );
      } catch (e: any) {
        const message = `reminder ${fileName} invalid, skipping:`;
        console.error(message, e?.message ?? e);
        continue;
      }

      const is_past_reminder =
        reminder.type === "absolute" && Date.parse(reminder.at) <= Date.now();
      if (is_past_reminder) {
        await rm(path, { force: true });
        continue;
      }

      const pattern =
        reminder.type === "repeating" ? reminder.cron : reminder.at;
      try {
        const cronFunction = () =>
          runTurn(`${REMINDER_PROMPT} ${reminder.prompt}`);
        jobs.push(new Cron(pattern, { timezone: reminder.tz }, cronFunction));
      } catch (e: any) {
        const message = `reminder ${fileName} unschedulable, skipping:`;
        console.error(message, e?.message ?? e);
      }
    }
  };

  return { runTurn, syncReminders, ask };
};
