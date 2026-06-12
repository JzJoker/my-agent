import { Bot } from "grammy";
import {
  generateText,
  gateway as aiGateway,
  stepCountIs,
  tool,
  type ModelMessage,
} from "ai";
import { Laminar, getTracer, wrapLanguageModel } from "@lmnr-ai/lmnr";
import { z } from "zod";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { Cron } from "croner";
import { createBashTool } from "bash-tool";
import { Bash, ReadWriteFs } from "just-bash";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import telegramify from "telegramify-markdown";
import { reminderSchema } from "./types";
import { REMINDER_PROMPT, SYSTEM_PROMPT } from "./prompts";
import { isNil } from "lodash-es";

Laminar.initialize({
  projectApiKey: process.env.LMNR_PROJECT_API_KEY,
  ...(process.env.LMNR_BASE_URL && {
    baseUrl: process.env.LMNR_BASE_URL,
    httpPort: process.env.LMNR_HTTP_PORT
      ? Number(process.env.LMNR_HTTP_PORT)
      : undefined,
    grpcPort: process.env.LMNR_GRPC_PORT
      ? Number(process.env.LMNR_GRPC_PORT)
      : undefined,
  }),
});

// ---- Data dir (Fly volume at /data in prod, ./data locally) ----------------
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
await mkdir(join(DATA_DIR, "conversations"), { recursive: true });
await mkdir(join(DATA_DIR, "memory"), { recursive: true });

// File tools, rooted at DATA_DIR.
const sandbox = new Bash({ fs: new ReadWriteFs({ root: DATA_DIR }), cwd: "/" });
const { tools: fileTools } = await createBashTool({
  sandbox,
  destination: "/",
});

// ---- Conversation transcript -----------------
const today = () => new Date().toLocaleDateString("en-CA"); // TODO: make this an env var
const dayFile = (date: string) =>
  join(DATA_DIR, "conversations", `${date}.json`);
const readJson = async <T>(path: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
};

type Logged = { role: "user" | "assistant"; content: string; ts: number };
const logMessage = async (role: Logged["role"], content: string) => {
  const path = dayFile(today());
  const entries = await readJson<Logged[]>(path, []);
  entries.push({ role, content, ts: Date.now() });
  await writeFile(path, JSON.stringify(entries, null, 2));
};

// Context each turn = yesterday + today's transcript, in time order.
const loadHistory = async (): Promise<ModelMessage[]> => {
  const yesterday = new Date(Date.now() - 86400_000).toLocaleDateString(
    "en-CA",
  );
  const entries = [
    ...(await readJson<Logged[]>(dayFile(yesterday), [])),
    ...(await readJson<Logged[]>(dayFile(today()), [])),
  ];
  return entries.map((e) => ({ role: e.role, content: e.content }));
};

let deliver: (text: string) => Promise<void> = async () => {};

const COMPOSIO_TOOLS = [
  "GMAIL_FETCH_EMAILS",
  "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
  "GMAIL_CREATE_EMAIL_DRAFT",
  "GMAIL_SEARCH_PEOPLE",
  "GOOGLECALENDAR_FIND_EVENT",
  "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS",
  "GOOGLECALENDAR_EVENTS_GET",
  "GOOGLECALENDAR_FREE_BUSY_QUERY",
  "GOOGLECALENDAR_CREATE_EVENT",
];
let composioTools: Record<string, any> = {};
if (process.env.COMPOSIO_API_KEY && process.env.COMPOSIO_USER_ID) {
  try {
    composioTools = await new Composio({
      provider: new VercelProvider(),
    }).tools.get(process.env.COMPOSIO_USER_ID, { tools: COMPOSIO_TOOLS });
  } catch (e: any) {
    console.error("Composio tools unavailable:", e.message);
  }
}

const tools = {
  ...fileTools, // bash, readFile, writeFile — sandboxed to DATA_DIR
  tavily_search: tool({
    description:
      "Search the web with Tavily and return the top results as JSON.",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, max_results: 5 }),
      });
      return JSON.stringify(await r.json());
    },
  }),
  ...composioTools,
};

const model = wrapLanguageModel(aiGateway("google/gemini-2.5-flash"));

let running = false; // serialize turns (live messages + firing reminders)
const runTurn = async (message: string) => {
  while (running) await new Promise((r) => setTimeout(r, 100));
  running = true;
  try {
    await logMessage("user", message);
    const result = await generateText({
      model,
      tools,
      stopWhen: stepCountIs(20),
      system: SYSTEM_PROMPT,
      messages: await loadHistory(),
      experimental_telemetry: { isEnabled: true, tracer: getTracer() },
    });

    // Final text is the reply (interim messages already went out via sendMessage).
    if (result.text.trim()) {
      await deliver(result.text);
      await logMessage("assistant", result.text);
    }
  } catch (e: any) {
    console.error("turn failed:", e?.message ?? e);
  } finally {
    running = false;
  }
  await syncReminders();
};

let jobs: Cron[] = [];
const remindersPath = join(DATA_DIR, "reminders.json");

// stop and restart all jobs; invalid and expired entries are pruned from the file
const syncReminders = async () => {
  const raw = await readJson<unknown[]>(remindersPath, []);
  const live_reminders = raw
    .flatMap((r) => {
      const parsed = reminderSchema.safeParse(r);
      if (!parsed.success)
        console.error("invalid reminder, dropping:", JSON.stringify(r));
      return parsed.success ? [parsed.data] : [];
    })
    .filter((r) => !(r.type === "absolute" && Date.parse(r.at) <= Date.now()));
  if (live_reminders.length !== raw.length) {
    await writeFile(remindersPath, JSON.stringify(live_reminders, null, 2));
  }
  jobs.forEach((job) => job.stop());
  jobs = live_reminders.flatMap((reminder) => {
    const onFire = () => runTurn(`${REMINDER_PROMPT} ${reminder.prompt}`);
    const pattern = reminder.type === "repeating" ? reminder.cron : reminder.at;
    try {
      return [new Cron(pattern, { timezone: reminder.tz }, onFire)];
    } catch (e: any) {
      console.error(
        `reminder ${reminder.id} unschedulable, skipping:`,
        e?.message ?? e,
      );
      return [];
    }
  });
};

const {
  values: { mode },
} = parseArgs({ options: { mode: { type: "string" } } });

if (mode === "telegram") {
  const bot = new Bot(process.env.TELEGRAM_TOKEN!);
  const markdownText = (text: string) =>
    telegramify(text.slice(0, 4096), "escape");
  let currentChatId: number | undefined;
  deliver = async (text) => {
    if (!isNil(currentChatId)) {
      await bot.api.sendMessage(currentChatId, markdownText(text), {
        parse_mode: "MarkdownV2",
      });
    }
  };
  bot.on("message:text", async (ctx) => {
    currentChatId = ctx.chat.id;
    await runTurn(ctx.message.text);
  });
  await syncReminders();
  const shutdown = async () => {
    await bot.stop();
    await Laminar.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  bot.start();
} else if (mode === "cli") {
  deliver = async (text) => console.log(`\nAGENT: ${text}\n`);
  await syncReminders();
  const rl = createInterface({ input: stdin, output: stdout });
  while (true) {
    let line: string;
    try {
      line = (await rl.question("USER: ")).trim();
    } catch {
      break;
    }
    if (line === "exit") break;
    if (!line) continue;
    await runTurn(line);
  }
  await Laminar.shutdown();
  process.exit(0);
} else {
  console.error("Specify --mode telegram or --mode cli");
  process.exit(1);
}
