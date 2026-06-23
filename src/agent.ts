import { getTracer, wrapLanguageModel } from "@lmnr-ai/lmnr";
import { gateway as aiGateway, generateText, stepCountIs } from "ai";
import { Mutex } from "async-mutex";
import { Cron } from "croner";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { remindersDir } from "./config";
import { getConversationHistoryWindow, logMessage } from "./conversations";
import { buildSystemPrompt, REMINDER_PROMPT } from "./prompts";
import { tools } from "./tools";
import { reminderSchema } from "./types";

const model = wrapLanguageModel(aiGateway("google/gemini-3.5-flash"));

export type Agent = {
  runTurn: (message: string) => Promise<void>;
  syncReminders: () => Promise<void>;
};
export type CreateAgent = (deliver: (text: string) => Promise<void>) => Agent;

export const createAgent: CreateAgent = (deliver) => {
  const lock = new Mutex();
  let jobs: Cron[] = [];

  const runTurn = (message: string) =>
    lock.runExclusive(async () => {
      try {
        await logMessage("user", message);
        const result = await generateText({
          model,
          tools,
          system: await buildSystemPrompt(),
          messages: await getConversationHistoryWindow(),
          experimental_telemetry: { isEnabled: true, tracer: getTracer() },
        });
        if (result.text.trim()) {
          await deliver(result.text);
          await logMessage("assistant", result.text);
        }
      } catch (e: any) {
        console.error("turn failed:", e?.message ?? e);
      }
      await syncReminders();
    });

  // Stop every live job and rebuild from the files on disk.
  const syncReminders = async () => {
    jobs.forEach((job) => job.stop());
    jobs = [];

    const files = (await readdir(remindersDir)).filter((f) =>
      f.endsWith(".yaml"),
    );
    for (const file of files) {
      const path = join(remindersDir, file);
      let reminder;
      try {
        reminder = reminderSchema.parse(
          parseYaml(await readFile(path, "utf8")),
        );
      } catch (e: any) {
        console.error(`reminder ${file} invalid, skipping:`, e?.message ?? e);
        continue;
      }
      // A one-shot whose instant has passed (fired, or missed while down) is deleted, not scheduled.
      if (
        reminder.type === "absolute" &&
        Date.parse(reminder.at) <= Date.now()
      ) {
        await rm(path, { force: true });
        continue;
      }
      const pattern =
        reminder.type === "repeating" ? reminder.cron : reminder.at;
      try {
        jobs.push(
          new Cron(pattern, { timezone: reminder.tz }, () =>
            runTurn(`${REMINDER_PROMPT} ${reminder.prompt}`),
          ),
        );
      } catch (e: any) {
        console.error(
          `reminder ${file} unschedulable, skipping:`,
          e?.message ?? e,
        );
      }
    }
  };

  return { runTurn, syncReminders };
};
