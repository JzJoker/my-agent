import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { getTracer, Laminar, wrapLanguageModel } from "@lmnr-ai/lmnr";
import {
  gateway as aiGateway,
  generateText,
  stepCountIs,
  tool,
  type ModelMessage,
} from "ai";
import { Mutex } from "async-mutex";
import { Cron } from "croner";
import { execa } from "execa";
import { Bot } from "grammy";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import telegramify from "telegramify-markdown";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { getSystemPrompt, REMINDER_PROMPT } from "./prompts";
import { reminderSchema } from "./types";

Laminar.initialize({
  projectApiKey: process.env.LMNR_PROJECT_API_KEY,
  ...(process.env.LMNR_BASE_URL && {
    baseUrl: process.env.LMNR_BASE_URL,
    httpPort: Number(process.env.LMNR_HTTP_PORT) ?? undefined,
    grpcPort: Number(process.env.LMNR_GRPC_PORT) ?? undefined,
  }),
});

const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const remindersDir = join(DATA_DIR, "reminders");
await mkdir(join(DATA_DIR, "conversations"), { recursive: true });
await mkdir(join(DATA_DIR, "memory"), { recursive: true });
await mkdir(remindersDir, { recursive: true });

// The agent runs git itself (it has real bash). Wire the deploy key + remote
// once on boot so its `git push`/`pull` authenticate; the agent owns the actual
// committing/pushing/pulling. No-op unless MEMORY_REPO + MEMORY_DEPLOY_KEY are set.
if (process.env.MEMORY_DEPLOY_KEY && process.env.MEMORY_REPO) {
  const keyPath = join(homedir(), ".ssh", "id_memory");
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, `${process.env.MEMORY_DEPLOY_KEY.trim()}\n`, {
    mode: 0o600,
  });
  const cfg = (...a: string[]) => execa("git", ["config", "--global", ...a]);
  await cfg(
    "core.sshCommand",
    `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
  );
  await cfg("user.name", "harry");
  await cfg("user.email", "harry@my-agent");
  await cfg("--add", "safe.directory", DATA_DIR);
  if (!(await stat(join(DATA_DIR, ".git")).catch(() => null))) {
    await execa("git", ["-C", DATA_DIR, "init"]);
    await execa("git", ["-C", DATA_DIR, "remote", "add", "origin", process.env.MEMORY_REPO]);
    await execa("git", ["-C", DATA_DIR, "branch", "-M", "main"]);
  }
}

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

const getConversationHistoryWindow = async (): Promise<ModelMessage[]> => {
  const yesterday = new Date(Date.now() - 86400_000).toLocaleDateString(
    "en-CA",
  );
  const entries = [
    ...(await readJson<Logged[]>(dayFile(yesterday), [])),
    ...(await readJson<Logged[]>(dayFile(today()), [])),
  ];
  return entries.map((e) => ({ role: e.role, content: e.content }));
};

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

const getComposioTools = async () => {
  if (process.env.COMPOSIO_API_KEY && process.env.COMPOSIO_USER_ID) {
    try {
      const composio = new Composio({ provider: new VercelProvider() });
      return composio.tools.get(process.env.COMPOSIO_USER_ID, {
        tools: COMPOSIO_TOOLS,
      });
    } catch (e: any) {
      console.error("Composio tools unavailable:", e.message);
    }
  }
  return {};
};

const MAX_OUTPUT = 30_000; // cap tool output so it doesn't blow the context window
const truncate = (s: string) =>
  s.length <= MAX_OUTPUT
    ? s
    : `${s.slice(0, MAX_OUTPUT / 2)}\n…[truncated ${s.length - MAX_OUTPUT} chars]…\n${s.slice(-MAX_OUTPUT / 2)}`;

const tools = {
  bash: tool({
    description:
      "Run a bash command on your computer (working dir = your data dir). Returns stdout, stderr, exitCode; a non-zero exit is returned, not thrown.",
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }) => {
      const r = await execa("bash", ["-lc", command], {
        cwd: DATA_DIR,
        timeout: 120_000,
        reject: false,
        maxBuffer: 50_000_000,
      });
      return {
        stdout: truncate(r.stdout ?? ""),
        stderr: truncate(r.stderr ?? ""),
        exitCode: r.exitCode ?? (r.timedOut ? 124 : 1),
      };
    },
  }),
  readFile: tool({
    description: "Read a file (path relative to your data dir).",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      try {
        return {
          content: truncate(await readFile(resolve(DATA_DIR, path), "utf8")),
        };
      } catch (e: any) {
        return { error: e?.message ?? String(e) };
      }
    },
  }),
  writeFile: tool({
    description:
      "Write (overwrite) a file, path relative to your data dir. Prefer this over bash heredocs for multi-line content.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      const full = resolve(DATA_DIR, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
      return { ok: true, path };
    },
  }),
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
  ...(await getComposioTools()),
};

const model = wrapLanguageModel(aiGateway("google/gemini-3.5-flash"));

// An agent is bound to one delivery channel (a Telegram chat, or the CLI). The
// channel is injected here rather than held in a module-level mutable, so runTurn
// and the reminder scheduler close over it cleanly.
const createAgent = (deliver: (text: string) => Promise<void>) => {
  // One turn (or firing reminder) runs at a time. async-mutex gives FIFO
  // serialization and releases even if the body throws — no poisoned lock.
  const lock = new Mutex();
  // id (= reminder filename) -> its file mtime + live cron job.
  const jobs = new Map<string, { mtimeMs: number; job: Cron }>();

  const runTurn = (message: string) =>
    lock.runExclusive(async () => {
      try {
        await logMessage("user", message);
        const result = await generateText({
          model,
          tools,
          stopWhen: stepCountIs(20),
          system: getSystemPrompt(),
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

  // Reminders are one YAML file each at /reminders/<id>.yaml (filename = id).
  // We only (re)schedule files whose mtime changed since last sync, and stop
  // jobs whose file was deleted — so an edit to one reminder doesn't churn the
  // rest. Called on boot and at the end of every turn.
  const syncReminders = async () => {
    const files = (await readdir(remindersDir)).filter((f) =>
      f.endsWith(".yaml"),
    );
    const present = new Set<string>();

    for (const file of files) {
      const id = file.slice(0, -".yaml".length);
      const path = join(remindersDir, file);
      const { mtimeMs } = await stat(path);
      present.add(id);

      if (jobs.get(id)?.mtimeMs === mtimeMs) continue; // unchanged → leave it be
      jobs.get(id)?.job.stop();
      jobs.delete(id);

      let reminder;
      try {
        reminder = reminderSchema.parse(
          parseYaml(await readFile(path, "utf8")),
        );
      } catch (e: any) {
        console.error(`reminder ${id} invalid, skipping:`, e?.message ?? e);
        continue;
      }

      // A one-shot whose instant has already passed (fired, or missed while the
      // bot was down) is deleted, not scheduled.
      if (
        reminder.type === "absolute" &&
        Date.parse(reminder.at) <= Date.now()
      ) {
        await rm(path, { force: true });
        continue;
      }

      const pattern =
        reminder.type === "repeating" ? reminder.cron : reminder.at;
      const onFire = async () => {
        // One-shots remove themselves before running, so the post-turn sync
        // doesn't re-see (and re-fire) them.
        if (reminder.type === "absolute") {
          jobs.get(id)?.job.stop();
          jobs.delete(id);
          await rm(path, { force: true });
        }
        await runTurn(`${REMINDER_PROMPT} ${reminder.prompt}`);
      };
      try {
        const job = new Cron(pattern, { timezone: reminder.tz }, onFire);
        jobs.set(id, { mtimeMs, job });
      } catch (e: any) {
        console.error(
          `reminder ${id} unschedulable, skipping:`,
          e?.message ?? e,
        );
      }
    }

    // Files deleted on disk → stop and forget their jobs.
    for (const [id, { job }] of jobs) {
      if (!present.has(id)) {
        job.stop();
        jobs.delete(id);
      }
    }
  };

  return { runTurn, syncReminders };
};

const {
  values: { mode },
} = parseArgs({ options: { mode: { type: "string" } } });

if (mode === "telegram") {
  // Single-user bot: the chat id is config, set once. Available at boot so
  // reminders deliver even before the first inbound message after a restart.
  const chatId = Number(process.env.TELEGRAM_CHAT_ID);
  if (!Number.isFinite(chatId)) {
    console.error(
      "TELEGRAM_CHAT_ID is required in telegram mode (your chat id).",
    );
    process.exit(1);
  }
  const bot = new Bot(process.env.TELEGRAM_TOKEN!);
  const markdownText = (text: string) =>
    telegramify(text.slice(0, 4096), "escape");
  const { runTurn, syncReminders } = createAgent(async (text) => {
    await bot.api.sendMessage(chatId, markdownText(text), {
      parse_mode: "MarkdownV2",
    });
  });
  bot.on("message:text", async (ctx) => {
    if (ctx.chat.id !== chatId) return; // ignore anyone who isn't the owner
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
  const { runTurn, syncReminders } = createAgent(async (text) =>
    console.log(`\nAGENT: ${text}\n`),
  );
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
