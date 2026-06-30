import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "@lmnr-ai/lmnr";
import { isStepCount, ToolLoopAgent } from "ai";
import { Mutex } from "async-mutex";
import { Cron } from "croner";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
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

  return { runTurn, syncReminders };
};
