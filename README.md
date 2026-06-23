# my-agent

A minimal but capable **personal-assistant Telegram bot** — the whole agent is one
file (`bot.ts`, ~200 lines) built on the [Vercel AI SDK](https://sdk.vercel.ai).

- **Inference** — any model via the **Vercel AI Gateway** (one API key for chat *and*
  the memory layer; no per-provider keys).
- **Long-term memory** — self-hosted **[Mem0](https://github.com/mem0ai/mem0)**:
  it extracts and recalls facts about the user across turns. Vectors persist in
  **Qdrant** when `QDRANT_URL` is set; otherwise a local store for dev.
- **Tools** — **Tavily** web search, **Gmail + Google Calendar** via
  [Composio](https://composio.dev) (read / draft / create only — it never sends or
  deletes), and a tiny **SQLite-backed scheduler** for reminders & recurring tasks.
- **Tracing** — **[Laminar](https://lmnr.ai)** (OpenTelemetry) on every LLM call.

## Quick start

```bash
corepack enable                 # ensures pnpm 10 (pinned in package.json)
pnpm install
cp .env.example .env            # then fill in keys — see the table below
pnpm try                        # CLI REPL: type messages, "exit" to quit
```

`pnpm try` runs the full agent locally in a terminal REPL — the fastest way to poke
at it. To run the actual Telegram bot (long-polling):

```bash
pnpm dev                        # needs TELEGRAM_TOKEN
```

**Requirements:** Node 20+ and pnpm 10 (via `corepack enable`).

## Environment variables

Copy `.env.example` to `.env` and fill these in:

| Var | Required? | What it's for |
|---|---|---|
| `AI_GATEWAY_API_KEY` | **yes** | All inference — chat + Mem0's extraction/embeddings. From [Vercel AI Gateway](https://vercel.com/docs/ai-gateway). |
| `LMNR_PROJECT_API_KEY` | **yes** | Laminar tracing. Free project key from [lmnr.ai](https://lmnr.ai). |
| `TELEGRAM_TOKEN` | for Telegram | Bot token from [@BotFather](https://t.me/BotFather). Not needed for `pnpm try`. |
| `TAVILY_API_KEY` | for web search | From [tavily.com](https://tavily.com). |
| `COMPOSIO_API_KEY` + `COMPOSIO_USER_ID` | for Gmail/Calendar | Both must be set; the Google account is connected under that Composio user. |
| `QDRANT_URL` | prod only | Persistent memory vectors. Unset locally → in-process store. |

The bot degrades gracefully: leave a feature's keys unset and that feature is simply
skipped, so you can start with just `AI_GATEWAY_API_KEY` + `LMNR_PROJECT_API_KEY`.

## How it works

```
Telegram ──► bot.ts (grammY long-poll) ──► generateText (Vercel AI SDK, via AI Gateway)
                 │                            tools: tavily_search, schedule_task, Gmail, Calendar
                 ├─ before each turn:  memory.search()  → inject recalled facts into the system prompt
                 └─ after each turn:   memory.add()     → Mem0 extracts & stores new facts
```

Scheduled tasks live in a small SQLite table; a 60-second sweep ticker fires due rows
and delivers the result back to the chat.

## Scripts

| Command | What |
|---|---|
| `pnpm try` | Local CLI REPL (best for testing). |
| `pnpm dev` | Telegram bot with `--watch` (auto-reload). |
| `pnpm start` | Telegram bot, no watch. |

## Deploying

Runs on a self-hosted Linux host as a rootless **systemd** user service (long-polls
Telegram, no public port). See [`DEPLOY.md`](./DEPLOY.md) for the deploy workflow and
[`CLAUDE.md`](./CLAUDE.md) for restart/debugging docs (logs, traces, Composio connections).

## More

[`CLAUDE.md`](./CLAUDE.md) has the architecture deep-dive, key gotchas, and ops runbook.
