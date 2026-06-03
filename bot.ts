import { Bot } from "grammy";
import { generateText, gateway as aiGateway, stepCountIs, tool, type ModelMessage } from "ai";
import { Laminar, getTracer, wrapLanguageModel } from "@lmnr-ai/lmnr";
import { z } from "zod";
import { Memory } from "mem0ai/oss";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import Database from "better-sqlite3";
import { Cron } from "croner";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import telegramify from "telegramify-markdown";

// Laminar tracing (OTel) — initialize once; pass getTracer() to each AI SDK call below.
// When LMNR_BASE_URL is set, point at a local app_server (e.g. the debugger branch) on
// LMNR_HTTP_PORT/LMNR_GRPC_PORT; unset in prod → defaults to cloud api.lmnr.ai.
Laminar.initialize({
  projectApiKey: process.env.LMNR_PROJECT_API_KEY,
  ...(process.env.LMNR_BASE_URL && {
    baseUrl: process.env.LMNR_BASE_URL,
    httpPort: process.env.LMNR_HTTP_PORT ? Number(process.env.LMNR_HTTP_PORT) : undefined,
    grpcPort: process.env.LMNR_GRPC_PORT ? Number(process.env.LMNR_GRPC_PORT) : undefined,
  }),
});

// Mem0 hardcodes response_format {type:"json_object"}, which the AI Gateway rejects
// (it only accepts json_schema). The OpenAI SDK uses its own fetch, so a monkeypatch
// can't reach it — instead run a tiny in-process proxy that rewrites the field and
// forwards to the gateway. Keeps ALL inference on one AI_GATEWAY_API_KEY.
const GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh";
const proxy = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let body = Buffer.concat(chunks).toString("utf8");
    try {
      const b = JSON.parse(body);
      if (b?.response_format?.type === "json_object") {
        b.response_format = { type: "json_schema", json_schema: { name: "response", schema: { type: "object" } } };
        body = JSON.stringify(b);
      }
    } catch { }
    const r = await fetch(GATEWAY_ORIGIN + req.url, {
      method: req.method,
      headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
});
await new Promise<void>((ok) => proxy.listen(8788, "127.0.0.1", ok));

// Self-hosted Mem0 — extraction LLM + embeddings both routed through the gateway
// (via the proxy above, one AI_GATEWAY_API_KEY, no OpenAI key). Vectors persist in
// a dedicated Qdrant Fly app when QDRANT_URL is set; otherwise in-memory for local dev.
const gateway = { apiKey: process.env.AI_GATEWAY_API_KEY, baseURL: "http://127.0.0.1:8788/v1" };
const memory = new Memory({
  llm: { provider: "openai", config: { ...gateway, model: "openai/gpt-4o-mini" } },
  embedder: { provider: "openai", config: { ...gateway, model: "openai/text-embedding-3-small", embeddingDims: 1536 } },
  ...(process.env.QDRANT_URL && {
    vectorStore: { provider: "qdrant", config: { url: process.env.QDRANT_URL, collectionName: "memories", dimension: 1536 } },
  }),
});

// Scheduled tasks: a tiny SQLite table (on the Fly volume /data in prod). The agent
// writes rows via the schedule_task tool; a sweep ticker fires due rows and delivers
// the result to Telegram. One DB, one file, no extra app.
const db = new Database(process.env.SCHEDULE_DB_PATH ?? "schedules.db");
db.exec(
  `CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, prompt TEXT NOT NULL,
    cron TEXT, tz TEXT, next_run_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
);
// CRITICAL/single-user: the tool learns "which chat" from this module-level var, set on
// each inbound message and before each scheduled run. Fine for one user; with concurrent
// users a schedule_task call could attribute to the wrong chat.
let currentChatId: number | undefined;
// Shared Telegram conversation history (short-term). Scheduled runs read AND append to it,
// so a fired task has the same chat context as a live message. CRITICAL: grows unbounded
// (token cost climbs over a long-lived process — add trimming later).
const history: ModelMessage[] = [];

// Pending Mem0 writes. add() runs async (so the reply isn't blocked on extraction),
// but the promises are tracked here so the shutdown paths can flush them — otherwise
// the most recent exchange is dropped when the process exits/restarts mid-write.
const pendingWrites = new Set<Promise<unknown>>();

const recall = async (query: string, userId: string) => {
  try {
    // Bound the recall: an unbounded Mem0 search returns EVERY memory ranked by
    // score, so without a limit the entire store gets injected into every system
    // prompt (unbounded token growth + mostly-irrelevant context). Top-K only.
    const { results } = await memory.search(query, { userId, limit: 6 });
    return results.map((r: { memory: string }) => `- ${r.memory}`).join("\n");
  } catch (e: any) {
    // Don't fail the turn if memory is unavailable — but DO surface it. A silent
    // "" here previously hid gateway/proxy/Qdrant outages completely.
    console.error("memory.search failed:", e?.message ?? e);
    return "";
  }
};

// Composio: a curated set of Gmail + Google Calendar tools for the connected Google
// account (scoped to COMPOSIO_USER_ID). Skipped if env not set, so local dev still runs.
const COMPOSIO_TOOLS = [
  // Email: read + DRAFT only — the bot never sends; you review and send from Gmail.
  "GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_SEARCH_PEOPLE",
  // Calendar: view + create only (no delete).
  "GOOGLECALENDAR_FIND_EVENT", "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS", "GOOGLECALENDAR_EVENTS_GET",
  "GOOGLECALENDAR_FREE_BUSY_QUERY", "GOOGLECALENDAR_CREATE_EVENT",
];
let composioTools: Record<string, any> = {};
if (process.env.COMPOSIO_API_KEY && process.env.COMPOSIO_USER_ID) {
  try {
    composioTools = await new Composio({ provider: new VercelProvider() })
      .tools.get(process.env.COMPOSIO_USER_ID, { tools: COMPOSIO_TOOLS });
  } catch (e: any) {
    console.error("Composio tools unavailable:", e.message);
  }
}

const tools = {
  tavily_search: tool({
    description: "Search the web with Tavily and return the top results as JSON.",
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
  schedule_task: tool({
    description:
      "Schedule a future task or recurring reminder. Provide `cron` (5-field) for recurring, " +
      "or `at` (ISO 8601 datetime) for a one-time task. When it fires, `prompt` is run as a fresh " +
      "request and the result is sent to the user. Always include the user's IANA `tz` for correct timing.",
    inputSchema: z.object({
      prompt: z.string().describe("What to do when it fires, phrased as an instruction to your future self — e.g. 'Remind the user to eat bread' or 'Send the user their calendar + top AI news'"),
      cron: z.string().optional().describe("5-field cron for recurring, e.g. '0 8 * * 1-5'"),
      at: z.string().optional().describe("ISO 8601 datetime for a one-time task"),
      tz: z.string().optional().describe("IANA timezone, e.g. America/Los_Angeles"),
    }),
    execute: async ({ prompt, cron, at, tz }) => {
      if (currentChatId === undefined) return "No chat context to schedule for.";
      let next: number;
      if (cron) {
        const n = new Cron(cron, { timezone: tz }).nextRun();
        if (!n) return "Invalid cron expression.";
        next = n.getTime();
      } else if (at) {
        next = Date.parse(at);
        if (Number.isNaN(next)) return "Invalid datetime.";
      } else {
        return "Provide either `cron` or `at`.";
      }
      db.prepare(
        "INSERT INTO schedules (chat_id, prompt, cron, tz, next_run_at, created_at) VALUES (?,?,?,?,?,?)",
      ).run(String(currentChatId), prompt, cron ?? null, tz ?? null, next, Date.now());
      return `Scheduled. Next run: ${new Date(next).toString()}.`;
    },
  }),
  ...composioTools,
};

const model = wrapLanguageModel(aiGateway("google/gemini-2.5-flash"));

const run = async (messages: ModelMessage[], userId: string) => {
  const last = messages[messages.length - 1];
  const query = typeof last?.content === "string" ? last.content : "";
  const memories = await recall(query, userId);

  const result = await generateText({
    model,
    tools,
    stopWhen: stepCountIs(20),
    system:
      "You are a helpful personal assistant with long-term memory, web search, and access to " +
      "the user's Gmail and Google Calendar. Use web search for current information. For email you can " +
      "read messages and prepare DRAFTS only — you cannot send, so tell the user to review and send the " +
      "draft from Gmail. You can view the calendar and create events. " +
      `The current date and time is ${new Date().toString()} — use it to resolve "today", "tomorrow", etc. ` +
      "Below is what you remember about this user — rely on it, weave it in naturally.\n\n--- MEMORY ---\n" +
      (memories || "(nothing yet)"),
    messages,
    // Laminar needs its tracer passed explicitly (initialize() does NOT auto-instrument).
    experimental_telemetry: { isEnabled: true, tracer: getTracer() },
  });

  // Push the exchange to long-term memory; Mem0 extracts/dedupes facts for us.
  // Fire-and-forget so the reply isn't blocked on extraction (~seconds), but TRACK
  // the promise so the shutdown paths can flush it — otherwise the last exchange is
  // lost when the process exits (CLI) or restarts (prod) before the write lands.
  const write = memory
    .add(
      [
        { role: "user", content: query },
        { role: "assistant", content: result.text },
      ],
      { userId },
    )
    .catch((e: any) => console.error("memory.add failed:", e?.message ?? e))
    .finally(() => pendingWrites.delete(write));
  pendingWrites.add(write);

  return result;
};

// Sweep ticker: every 60s (and once on boot for catch-up) fire all due rows sequentially.
// CRITICAL: at-least-once — a crash after run/deliver but before advancing the row re-fires it
// on reboot (possible duplicate). Missed runs while down are coalesced to one fire, not one
// per missed interval. Single in-process guard prevents overlapping sweeps.
const startScheduler = (deliver: (chatId: number, text: string) => Promise<unknown>) => {
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const due = db.prepare("SELECT * FROM schedules WHERE next_run_at <= ?").all(Date.now()) as any[];
      for (const row of due) {
        try {
          currentChatId = Number(row.chat_id);
          history.push({
            role: "user",
            content:
              "[SCHEDULED TASK — this is NOT a live message from the user. A task the user scheduled " +
              "earlier is firing now. Address the user directly and carry it out (e.g. deliver the reminder), " +
              "using the conversation above for context.]\n\nScheduled instruction: " + row.prompt,
          });
          const result = await run(history, `tg:${row.chat_id}`);
          history.push(...result.response.messages);
          await deliver(Number(row.chat_id), result.text.slice(0, 4096));
        } catch (e: any) {
          console.error("scheduled run failed:", e.message);
        }
        if (row.cron) {
          const n = new Cron(row.cron, { timezone: row.tz ?? undefined }).nextRun();
          if (n) db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(n.getTime(), row.id);
          else db.prepare("DELETE FROM schedules WHERE id = ?").run(row.id);
        } else {
          db.prepare("DELETE FROM schedules WHERE id = ?").run(row.id);
        }
      }
    } finally {
      sweeping = false;
    }
  };
  sweep();
  setInterval(sweep, 60_000);
};

const { values: { mode } } = parseArgs({ options: { mode: { type: "string" } } });

if (mode === "telegram") {
  const bot = new Bot(process.env.TELEGRAM_TOKEN!);
  // Render the model's markdown in Telegram. MarkdownV2 is strict (most punctuation must be
  // escaped, and **bold**/#headers/-bullets aren't native), so convert standard markdown →
  // Telegram-safe MarkdownV2 with telegramify-markdown. Fall back to plain text if Telegram
  // still rejects the entities, so a reply is never dropped on a formatting error.
  const sendMarkdown = async (chatId: number, text: string) => {
    const body = text.slice(0, 4096);
    try {
      await bot.api.sendMessage(chatId, telegramify(body, "escape"), { parse_mode: "MarkdownV2" });
    } catch {
      await bot.api.sendMessage(chatId, body);
    }
  };
  bot.on("message:text", async (ctx) => {
    currentChatId = ctx.chat.id;
    history.push({ role: "user", content: ctx.message.text });
    const result = await run(history, `tg:${ctx.chat.id}`);
    history.push(...result.response.messages);
    await sendMarkdown(ctx.chat.id, result.text);
  });
  startScheduler((id, text) => sendMarkdown(id, text));
  // Graceful shutdown (Fly sends SIGTERM on deploy/restart): stop polling, flush any
  // in-flight memory writes so the latest exchanges persist, then exit.
  const shutdown = async () => {
    await bot.stop();
    await Promise.allSettled([...pendingWrites]);
    await Laminar.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  bot.start();

} else if (mode === "cli") {
  const rl = createInterface({ input: stdin, output: stdout });
  const messages: ModelMessage[] = [];
  while (true) {
    let line: string;
    try {
      line = (await rl.question("USER: ")).trim();
    } catch {
      break;
    }
    if (line === "exit") break;
    if (!line) continue;
    messages.push({ role: "user", content: line });
    const result = await run(messages, "cli");
    messages.push(...result.response.messages);
    console.log(`\nAGENT: ${result.text}\n`);
  }
  // Flush any in-flight memory writes before exiting, or the last turn(s) never persist.
  await Promise.allSettled([...pendingWrites]);
  await Laminar.shutdown();
  process.exit(0);

} else {
  console.error("Specify --mode telegram or --mode cli");
  process.exit(1);
}
