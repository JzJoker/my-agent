# Laminar Debugger

Use when building, testing, or debugging an LLM agent instrumented with Laminar. Covers recording a run under `LMNR_DEBUG`, inspecting the resulting trace with the Laminar CLI's SQL, replaying cached LLM calls to iterate fast and deterministically, and annotating debug sessions (names + per-trace markdown notes) so the user can follow what happened.

## Your role

You are the **parent agent**: the coding agent doing the building. The **child
agent** is the AI agent you are working on. Laminar exposes a suite of tools you must use to build, test, and debug more effectively.

You also own a second responsibility the human relies on: **making the debug
session legible**. You name each session and write a markdown note on every
trace, because the user reads those notes — not the raw spans — to understand
what you did and why.

## The core loop

**Record** — run the child agent once under the debugger to capture a trace.

**Inspect** — query the trace to understand what happened and where it went
wrong.

**Annotate** — name the session and write a note on the trace so the run is
self-explanatory in the UI.

**Replay + edit** — make your code/prompt change, then re-run replaying the
cached calls up to the point of interest and executing live past it.

**Repeat** — each iteration only pays for the calls that actually changed.

## Prerequisite: instrument the child agent

Before any of this works, the child agent must be properly instrumented with Laminar. If this has not been done yet, see [instrumentation-typescript.md](instrumentation-typescript.md) or [instrumentation-python.md](instrumentation-python.md), or learn how to instrument [here](https://laminar.sh/docs/tracing/integrations/overview).

## Prerequisite: access the CLI

Make sure the Laminar CLI is working in your environment. See [cli.md](cli.md), or learn more about the CLI [here](https://laminar.sh/docs/platform/cli#cli).

## 1. Record a run

Run the child agent with debug mode on:

```bash
LMNR_DEBUG=true python my_agent.py        # or whatever the run command is
```

Truthy values are `true`, `1`, `yes`, `on`. A debug run:

- mints a debug session and registers it with Laminar,
- exports all spans as a normal trace, and
- prints a `LMNR_DEBUG_RUN ` line to the console containing the run's ids and debugger URL.

**Always capture and filter stdout/stderr for `LMNR_DEBUG_RUN`.** That line is your handoff between runs — it carries the `trace_id`, `session_id`, and `debugger_url` you need for every subsequent step. Pipe the child agent's output and grep for it explicitly:

```bash
LMNR_DEBUG=true node my_agent.js 2>&1 | tee run.log
grep 'LMNR_DEBUG_RUN' run.log
```

The JSON payload on that line looks like:

```json
{
  "trace_id": "…",
  "session_id": "…",
  "replay_trace_id": null,
  "cache_until": 0,
  "debugger_url": "https://…/project/<projectId>/debugger-sessions/<sessionId>",
  "started_at": "…"
}
```

Extract what you need with `jq` or a simple pattern match. **Do not rely on the console output being easy to read at a glance** — other logging will drown the Laminar lines, so always grep explicitly.

### Persist the session id 

The `session_id` from your first run identifies this entire debugging session. **Every subsequent run MUST set `LMNR_DEBUG_SESSION_ID` to it** — a run without it silently mints a new, orphaned session and your traces stop appearing together in the UI.

Persist it the moment you capture it: save it to a file, or `export` it if your shell is long-lived. Before any run after the first, confirm it's set.

```bash
LMNR_DEBUG=true LMNR_DEBUG_SESSION_ID=<session-id> node my_agent.js
```

## 2. Name the session and note every trace

This is not optional. The session view is how the human follows your work, and a
bare session of unlabeled traces is unreadable.

Name the session once, describing the investigation:

```bash
npx lmnr-cli debug session set-name <session-id> "Fix report length + search tool"
```

Notes on a trace come in two forms that complement each other.

### Pre-run note (set before you run). Mandatory.

Write this note **before** launching the child agent. It appears in the UI the moment the trace lands there, giving the human a real-time view of your reasoning. Set it via the `LMNR_TRACE_METADATA` environment variable when you invoke the agent:

```bash
LMNR_DEBUG=true \
LMNR_DEBUG_SESSION_ID=<session-id> \
LMNR_TRACE_METADATA='{"rollout.note": "## What I am about to test\nReplaying calls 1–3, running call 4 (report synthesis) live with the new length cap.\n\n"}' \
node my_agent.js 2>&1 | tee run.log
```

Format: `LMNR_TRACE_METADATA` must be a stringified JSON object with key `rollout.note` whose value is your note in markdown. **End the value with a double newline `\n\n`** so subsequent `append-note` entries start cleanly on a new paragraph.

### Post-run note (appended after you run). Optional.

Write a follow-up note on **every** trace after it completes (aim for ~20–200 words of well-structured markdown — headings, short lists, inline code). Record what the trace actually showed, what you observed, and what to look at next.

```bash
npx lmnr-cli trace append-note <trace-id> "## What this run showed
The <span id='<spanId>' name='synthesis call' /> now returns ~180 words (was ~600).
Length cap is working. Next: check that citations are still intact."
```

Notes are **append-only**: each `append-note` call adds a new paragraph to the
trace's existing note — never re-send the whole note, just the new entry.

To re-orient yourself in an ongoing session (e.g. after a context reset), dump
every trace's note in order:

```bash
npx lmnr-cli debug session summary <session-id>          # or --json
```

Output is one block per trace, oldest first — the note followed by a
`<trace id="…" end-time="…"/>` tag you can feed back into the SQL queries
below.

Reference a specific span by embedding a **span tag** in the note — the UI
renders it as a clickable **span chip** that opens that span in the trace view:

```text
<span id='<spanId>' name='the synthesis call' />
```

- `id` is the span's UUID — the `span_id` you get from the SQL queries below.
- `name` is the chip's label (free text; keep it short).
- Optional `reference_text='…'` adds a muted inline preview after the label, e.g.
  `<span id='<spanId>' name='synthesis' reference_text='~180 words, was ~600' />`.

The span must belong to the trace the note is attached to.

## 3. Inspect the trace with SQL

The printed URL is optimized for humans; for *you*, querying is faster and more
precise. Every debug run stamps `rollout.session_id` on its trace, so you can
filter to exactly the runs you care about:

```sql
SELECT id AS trace_id, start_time, status, total_tokens
FROM traces
WHERE simpleJSONExtractString(metadata, 'rollout.session_id') = '<session-id>'
ORDER BY start_time DESC
LIMIT 10;
```

Run it through the CLI:

```bash
npx lmnr-cli sql query "SELECT id, start_time, status FROM traces ORDER BY start_time DESC LIMIT 20"
```

To locate the failure, read the trace's spans in order — which LLM call produced
the bad output, what its inputs were, and how far into the loop it happened.
That tells you where to set your replay boundary. `input`/`output` columns are
large, so select them only for the span you care about (and paginate):

```sql
SELECT span_id, name, span_type, start_time, status
FROM spans
WHERE trace_id = '<trace-id>'
ORDER BY start_time ASC;
```

`span_type` is one of `LLM`, `TOOL`, `DEFAULT`, or `CACHED` (a replayed LLM
call in a replay run's trace). Only **LLM calls along the loop** count toward
the cache window — tool executions don't. Rule of thumb: a tool-using turn
produces one LLM call per tool round-trip **plus one** final synthesis call
(N tool calls → N+1 LLM calls). To count the calls along the loop (this is what
`LMNR_DEBUG_CACHE_UNTIL` indexes into — replayed calls count too, so include
`CACHED` when the source trace is itself a replay):

```sql
SELECT count() FROM spans
WHERE trace_id = '<trace-id>' AND span_type IN ('LLM', 'CACHED');
```

Discover the full schema any time with `npx lmnr-cli sql schema`. Useful tables:
`spans`, `traces`, `events`, and `signal_events`. See
[sql-query-api.md](sql-query-api.md) for more query patterns.

### Signal events — recent errors and insights

`signal_events` records signals fired during runs (evaluation failures,
flagged conditions, insights). Scan it to surface what recently went wrong
without reading every trace:

```sql
SELECT timestamp, name, trace_id, payload
FROM signal_events
ORDER BY timestamp DESC
LIMIT 20;
```

Join back to the offending trace with the `trace_id`, then drop into its spans.

### Self-hosted / local Laminar

The CLI defaults to `https://api.lmnr.ai`. Point it at a local app-server with
flags (or `LMNR_BASE_URL` / `LMNR_PORT` in the environment):

```bash
npx lmnr-cli sql query "…" --base-url http://localhost --port 8000
```

## 4. Replay to iterate fast

After editing the child agent, re-run with explicit ids taken from the previous run's `LMNR_DEBUG_RUN` console line:

```bash
LMNR_DEBUG=true \
LMNR_DEBUG_SESSION_ID=<session-id> \
LMNR_DEBUG_REPLAY_TRACE_ID=<trace-id> \
LMNR_DEBUG_CACHE_UNTIL=3 \
node my_agent.js 2>&1 | tee run.log
grep 'LMNR_DEBUG_RUN' run.log
```

This replays the LLM calls along the agent's main loop from the source trace's
cache instead of hitting the model. Calls inside the cache window return their
recorded responses instantly; past it, the run goes live.

**`LMNR_DEBUG_SESSION_ID` is required on every run after the first.** It is what groups all your traces into one session in the UI. Without it, each run mints a new, orphaned session. Always read it from the `LMNR_DEBUG_RUN` line of your first (or most recent) run and carry it forward for the entire investigation.

**`LMNR_DEBUG_REPLAY_TRACE_ID`** tells the debugger which recorded trace to pull cached LLM responses from. Read the `trace_id` from the `LMNR_DEBUG_RUN` line of the run you want to replay. If you want to replay an earlier run (not the most recent one), use its `trace_id` from that run's captured output or from the session's SQL listing.

A fresh record run has `cache_until: 0` — and **a zero cache window means no replay at all** (the run is fully live). Always set `LMNR_DEBUG_CACHE_UNTIL` explicitly.

`LMNR_DEBUG_CACHE_UNTIL` accepts either form:

- **A count `N`** — replay the first N calls along the loop, then go live.
- **A span id** — replay *through* that span (inclusive: the named call itself
  comes from cache, the next one runs live). Accepts the span's full UUID, the
  last two UUID groups, the 16-hex OTel id, or any hex suffix — whatever you
  copied from SQL or the UI. A span id that isn't one of the loop's LLM calls
  warns and runs fully live.

```bash
LMNR_DEBUG=true \
LMNR_DEBUG_REPLAY_TRACE_ID=<trace-id> \
LMNR_DEBUG_CACHE_UNTIL=<n-or-span-id> \
node my_agent.js
```

Replaying up to *just before* the buggy call lets you re-run that one call live
with your fix, over and over, without re-executing everything that led up to it
— with the span-id form, pass the id of the call **before** the buggy one
(inclusive semantics). Set the window *past* the change to validate that the
rest of the loop now behaves. Each replayed iteration produces a new trace
under the same session, so attempts compare side by side in the UI (and you
should note each one — see step 2). Replayed traces can themselves be replay
sources — their cached calls count as loop positions just like live ones.

## What to keep in mind

**Replay is best-effort and never blocks you.** If the cache can't be built (no
clear loop in the source trace, or overlapping/parallel calls it can't safely
sequence), the run silently falls back to fully live — you still get a normal
debug trace, just no speedup. A live fallback is not an error.

**Replay assumes a sequential agent loop.** Wildly parallel LLM fan-out won't
replay cleanly; that's expected.

**Restart what doesn't hot-reload.** If the stack has a long-lived component
that loads code (e.g. a Temporal worker), restart it after every edit, otherwise your replay exercises stale code.

**Move your boundary, not your whole approach.** The fastest rhythm is: replay
up to the suspect call → tweak → re-run → read the new trace → adjust the
boundary. Resist re-running fully live every time — that's the cost the debugger
exists to avoid.

**Turn it off for production / normal runs** by simply not setting `LMNR_DEBUG`.
Everything is inert when it's unset.
