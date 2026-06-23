# my-agent — personal-assistant Telegram bot

A minimal personal assistant named **Harry**: a Telegram bot (grammY) on the Vercel
AI SDK, with a **plain-filesystem long-term memory**, Gmail + Google Calendar
tools (Composio), web search (Tavily), self-scheduled reminders, and tracing (Laminar).
All LLM inference runs through the Vercel AI Gateway on a single key. Runs on a self-hosted
Linux host as a systemd service (see [`DEPLOY.md`](./DEPLOY.md)).

Telegram bot: **@your_bot** (single-user — gated to one chat id).

## Architecture (`src/`, modular)

```
Telegram / CLI ──► channel ──► agent.runTurn ──► generateText (Vercel AI SDK)
                                  │                model: google/gemini-3.5-flash via AI Gateway
                                  │                tools: bash, readFile, writeFile,
                                  │                       web_search, web_extract, Composio (Gmail/Cal)
                                  │                tracing: Laminar (getTracer)
                                  ├─ workspace = WORKSPACE_DIR (bash cwd + file-tool root);
                                  │           memory = WORKSPACE_DIR/memory, greped/written via tools
                                  └─ reminders = YAML files in memory/reminders, scheduled by croner
```

Two run modes via `--mode`: `telegram` (long-polling worker) and `cli` (local REPL).

### File map (`src/`)
- **`index.ts`** — entrypoint. Laminar init, creates `WORKSPACE_DIR` + the memory subdirs, then
  dispatches to the channel named by `--mode`.
- **`agent.ts`** — `createAgent(deliver)` factory. `runTurn` (one `generateText` call,
  mutex-serialized so turns/reminders never overlap) and `syncReminders` (the croner scheduler).
  **The model is set here:** `google/gemini-3.5-flash`.
- **`config.ts`** — single source of truth for on-disk paths: `WORKSPACE_DIR` (bash/file root) and
  `MEMORY_DIR` (= `WORKSPACE_DIR/memory`) with its `notes/`, `conversations/`, `reminders/` subdirs.
- **`conversations.ts`** — transcript log: one JSON file per day under `memory/conversations`.
  History window passed to the model = yesterday's + today's files.
- **`prompts.ts`** — assembles the system prompt: reads the static prose from `src/AGENTS.md`
  (`readFileSync` at load), appends the `MEMORY.md` snapshot, then the current date. Also exports
  `REMINDER_PROMPT`.
- **`AGENTS.md`** — the static system-prompt prose (Harry's identity + filesystem/reminders/email
  conventions). Plain markdown, edited without touching code. Lives in `src/` (ships with the
  code; read at runtime by `tsx` — no build step copies it).
- **`types.ts`** — the reminder zod schema (`repeating` cron | `absolute` ISO instant).
- **`channels/`** — delivery surfaces behind a `Channel` interface. `telegram.ts` (grammY
  long-poll), `cli.ts` (REPL), `types.ts` (the interface).
- **`tools/`** — `bash.ts`, `files.ts` (readFile/writeFile), `web.ts` (Tavily-backed
  web_search/web_extract), `composio.ts` (Gmail/Calendar), `util.ts` (output truncation),
  `index.ts` (assembles the toolset, fetching Composio tools once at module load).

### The pieces
- **Model / inference:** `google/gemini-3.5-flash` through the **Vercel AI Gateway**
  (`AI_GATEWAY_API_KEY`) — one key for everything.
- **Workspace vs. memory.** `WORKSPACE_DIR` is the agent's "computer" — the `bash` cwd and the
  `readFile`/`writeFile` root. Its `memory/` subdir (`MEMORY_DIR`) is the self-contained, syncable
  memory unit: the agent reads, writes, and greps its own notes (`memory/notes`), reads the chat
  transcript (`memory/conversations`), and manages reminders (`memory/reminders`) via the tools.
  There is **no built-in backup/sync** — it lives on the host's local disk; back it up
  out-of-band if you want durability. Keeping memory as its own subdir means it can be
  synced as a unit later without dragging along workspace scratch.
  - **Two tiers:** `memory/MEMORY.md` is the *hot* tier — `prompts.ts` auto-injects its contents
    into the system prompt every turn, so the agent always has its key durable facts without
    searching. `memory/notes` is the *cold* tier (long tail), grepped on demand. The agent
    maintains `MEMORY.md` itself via `readFile`/`writeFile`.
- **Tools:** `bash` (real shell, cwd = `WORKSPACE_DIR`), `readFile`/`writeFile`, `web_search` +
  `web_extract` (Tavily, presented as generic web tools), **Composio** Gmail/Calendar (curated,
  read+draft+create only).
- **Reminders:** one YAML file per reminder in `memory/reminders`, scheduled with **croner**.
  Synced on boot and after every turn; only files whose mtime changed are rescheduled.
- **Tracing:** **Laminar** — `Laminar.initialize()` + `tracer: getTracer()` on the AI SDK call.

## Key gotchas (read before changing things)

1. **Laminar needs `tracer: getTracer()`** on every AI SDK call. `initialize()` alone does NOT
   auto-instrument — without the tracer, the dashboard stays empty. `index.ts` also reads
   `LMNR_BASE_URL` / `LMNR_HTTP_PORT` / `LMNR_GRPC_PORT` to point at a **self-hosted** Laminar.
2. **Single-user, gated by `TELEGRAM_CHAT_ID`.** The Telegram channel ignores any chat that
   isn't the owner's id (set once in config, available at boot so reminders deliver after a restart).
3. **Conversation history is per-day JSON files, not an in-memory array.** The model sees
   yesterday + today (`conversations.ts`); files survive restarts. Never write under
   `memory/conversations` from the agent — it's the read-only transcript.
4. **No built-in memory backup.** `memory/` is just a directory on local disk — nothing syncs it
   anywhere. If it's lost, the agent's memory is gone. It's a self-contained subdir of
   `WORKSPACE_DIR` precisely so it can be synced/backed up as a unit (cron `rsync`/snapshot, its
   own git repo, etc.) without dragging along workspace scratch.
5. **Composio user id is `<COMPOSIO_USER_ID>`** (`COMPOSIO_USER_ID`) — the Google account is
   connected under that Composio user. Tools are fetched for that id once at module load
   (`tools/composio.ts`); if the keys are unset it returns `{}` and the bot runs without them.
6. **Tool output is capped (`tools/util.ts`, 30k chars/stream).** `bash` tail-truncates and
   spills full output to a temp file whose path it reports; file reads middle-truncate. Default
   bash timeout 120s, max 600s.

## Running locally

```bash
cp .env.example .env     # fill in keys (see below)
pnpm try                 # CLI REPL — type messages, "exit" to quit  (best for testing)
pnpm dev                 # Telegram bot with --watch (needs TELEGRAM_TOKEN + TELEGRAM_CHAT_ID)
```
`pnpm try` runs the full agent against a local `WORKSPACE_DIR` (default `./workspace`, with memory
in `./workspace/memory`) — just a local folder, nothing synced anywhere.

### Environment variables (`.env`)
| Var | Required | What |
|---|---|---|
| `TELEGRAM_TOKEN` | yes (telegram) | bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | yes (telegram) | your chat id (single-user gate); get it from @userinfobot |
| `AI_GATEWAY_API_KEY` | yes | all inference via Vercel AI Gateway |
| `WORKSPACE_DIR` | no | the agent's bash cwd + file-tool root. Default `./workspace` |
| `MEMORY_DIR` | no | the memory unit (notes/conversations/reminders/MEMORY.md). Default `WORKSPACE_DIR/memory` |
| `TAVILY_API_KEY` | for web search | tavily.com |
| `LMNR_PROJECT_API_KEY` | for tracing | Laminar project key |
| `LMNR_BASE_URL` / `LMNR_HTTP_PORT` / `LMNR_GRPC_PORT` | self-hosted Laminar | point tracing at your own Laminar |
| `COMPOSIO_API_KEY` | for Gmail/Cal | composio.dev |
| `COMPOSIO_USER_ID` | for Gmail/Cal | Composio user the Google account is connected under |

## Deploying

Runs on a self-hosted Linux host as a **rootless systemd user service**. Git is the transport
(the host converges to `origin/main`), and `.env` + the workspace stay on the host. Full runbook —
one-time bootstrap, the everyday flow, ops — is in [`DEPLOY.md`](./DEPLOY.md).

```bash
./scripts/deploy.sh "what changed"   # commit + push, then host pulls/installs/restarts
```

`package.json` pins `packageManager: pnpm@10.25.0` (newer pnpm enforces a `minimumReleaseAge`
supply-chain policy that can fail installs).

## Restarting

```bash
systemctl --user restart my-agent    # on the host
systemctl --user status my-agent
```
The bot is a long-poll worker (no HTTP port); systemd keeps it running 24/7, restarting it on
crash and at boot. A restart re-reads `.env` and re-fetches Composio tools at startup. Long-term
memory and conversation transcripts survive (on local disk); in-process state (live cron jobs) is
rebuilt by `syncReminders` on boot.

## Debugging

### Logs
```bash
journalctl --user -u my-agent -f        # live tail (on the host)
journalctl --user -u my-agent -n 200    # recent
```

### Laminar traces (CLI — there is no MCP for Laminar)
The standalone `lmnr-cli` can SQL-query your traces (needs `LMNR_PROJECT_API_KEY` in env):
```bash
set -a; source .env; set +a
npx lmnr-cli@latest sql schema
npx lmnr-cli@latest sql query "SELECT start_time, total_tokens, status FROM traces ORDER BY start_time DESC LIMIT 10"
npx lmnr-cli@latest sql query "SELECT name, model, total_tokens FROM spans WHERE name='ai.generateText' ORDER BY start_time DESC LIMIT 5"
```
Tables: `spans`, `traces`, `events`. Or use the dashboard at https://lmnr.ai (the project that
owns `LMNR_PROJECT_API_KEY`). Note: the `@lmnr-ai/lmnr` bundled `lmnr` binary has NO trace query
(only `eval`/`dev`); use the separate `lmnr-cli` package for SQL.

### Memory (the memory dir)
Inspect what the agent has stored, on the host (memory is `$WORKSPACE_DIR/memory`):
```bash
ssh homelab 'ls -R ~/*/memory 2>/dev/null'    # or the exact WORKSPACE_DIR/memory path
ssh homelab 'cat $WORKSPACE_DIR/memory/MEMORY.md'
ssh homelab 'cat $WORKSPACE_DIR/memory/reminders/*.yaml'
```

### Composio (Gmail/Calendar connections)
Write a one-off script in the project dir (so `node_modules` resolves) and run with `tsx --env-file=.env`:
```ts
import { Composio } from "@composio/core";
const c = new Composio();
const list = await c.connectedAccounts.list({ userIds: [process.env.COMPOSIO_USER_ID!] });
console.log(list.items.map(a => `${a.toolkit?.slug}=${a.status}`));
```
Connections should be `ACTIVE`. If `INITIALIZING`/`EXPIRED`, the Google OAuth wasn't completed —
regenerate a link with `c.connectedAccounts.link(userId, authConfigId)` and finish the consent flow.
Auth configs: Gmail `<gmail-auth-config-id>`, Calendar `<calendar-auth-config-id>` (both Composio-managed).

## Tool safety
Composio tools are curated to **read + draft + create only** — no sending email, no deleting.
Edit the `COMPOSIO_TOOLS` array in `src/tools/composio.ts` to change the set (then redeploy).
Full toolkit lists: `composio.tools.get(userId, { toolkits: ["gmail"] })`. The `bash` tool, by
contrast, is a real unrestricted shell rooted at `WORKSPACE_DIR` — that's intentional (it's how the
agent manages its own memory), but keep it in mind.
