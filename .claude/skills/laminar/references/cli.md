# Laminar CLI

There are two CLIs. Pick based on the task:

- **`lmnr-cli`** — standalone npm package for querying data, managing datasets, and the agent debugger. Ships independently of the `@lmnr-ai/lmnr` SDK; no SDK install needed.
- **`lmnr` (SDK-bundled)** — shipped inside the `@lmnr-ai/lmnr` (TypeScript) and `lmnr` (Python) SDKs. Adds `eval` (run evaluations), `dev` (debugger), `datasets`, and `add-cursor-rules`.

When a user just wants to query data or push/pull datasets without touching the SDK, prefer `lmnr-cli`. When they're already in an SDK project and want to run evals or debug, use the bundled `lmnr`.

## Contents

- Auth and self-hosted config
- `lmnr-cli`: sql, datasets, dev
- Agent-friendly output (`--json`)
- SDK-bundled `lmnr`: eval, dev, datasets, add-cursor-rules

## Auth and self-hosted config

Every command authenticates with a project API key (dashboard → **Settings → Project API Keys**):

```bash
export LMNR_PROJECT_API_KEY=<your-key>
# or pass --project-api-key <key> on any command
# or put LMNR_PROJECT_API_KEY=<key> in a .env file in the working directory
```

Self-hosted deployments override the API URL and HTTP port. Do **not** include the port in `--base-url`:

```bash
lmnr-cli sql schema --base-url http://localhost --port 8000
```

Defaults: `--base-url https://api.lmnr.ai`, `--port 443` (use `8000` for local self-hosted).

`--base-url` / `--port` / `--project-api-key` belong to each subcommand group (`sql`,
`trace`, `debug`, `dataset`), **not** the top-level `lmnr-cli` — placing them before the
subcommand fails with `unknown option`. Appending them to the end of the full command
always works.

## `lmnr-cli`

Install:

```bash
npx lmnr-cli@latest <command>   # run without installing
npm install -g lmnr-cli         # or install globally
```

### sql — query data

Run SELECT-only ClickHouse SQL against the project's spans, traces, events, and more. Queries are auto-scoped to your project (no tenant filter needed).

```bash
lmnr-cli sql query "SELECT name, duration FROM spans WHERE start_time > now() - INTERVAL 1 HOUR LIMIT 20"
lmnr-cli sql schema   # list tables and columns
```

Add `--json` for machine-readable stdout (logs go to stderr), ideal for piping:

```bash
lmnr-cli sql query "SELECT trace_id, total_cost FROM spans WHERE span_type = 'LLM' LIMIT 10" --json \
  | jq '.[] | select(.total_cost > 0.01)'
```

For the table list, query guidance, and example queries, see [sql-query-api.md](sql-query-api.md).

### datasets — manage datasets

List, push, pull, and create datasets from `.jsonl` / `.json` / `.csv` files.

```bash
lmnr-cli dataset list --json
lmnr-cli dataset push data.jsonl -n my-dataset                  # add datapoints to existing dataset
lmnr-cli dataset pull output.jsonl -n my-dataset                # download a dataset
lmnr-cli dataset create my-dataset data.jsonl -o my-dataset.jsonl  # create + write local copy with IDs
```

### dev — agent debugger

Spins up an interactive debugging session for a function and connects it to the Laminar debugger UI so you can rerun, inspect, and edit inputs live.

```bash
lmnr-cli dev agent.ts                      # TypeScript
lmnr-cli dev agent.py                      # Python (script mode)
lmnr-cli dev -m src.agent                  # Python (module mode)
lmnr-cli dev agent.ts --function myAgent   # pick an entrypoint when several exist
```

### Help

```bash
lmnr-cli --help
lmnr-cli sql --help
lmnr-cli sql query --help
lmnr-cli dataset --help
lmnr-cli dev --help
```

## Agent-friendly output

`lmnr-cli` is built to plug into AI coding agents that shell out:

- **Structured stdout, logs on stderr.** Commands that support it take `--json`; machine-readable output goes to stdout while progress messages go to stderr, keeping pipes clean.
- **Non-zero exit codes on failure** — branch on success without parsing output.
- **Stable noun-verb surface** (`sql query`, `dataset push/pull/list/create`, `dev`) that's easy to compose.

Combined with `sql query --json`, this is a drop-in SQL layer for any agent, no SDK required.

## SDK-bundled `lmnr`

This CLI ships inside the SDKs. In TypeScript projects prefix with `npx`; in Python projects call `lmnr` directly (after `pip install lmnr`).

### eval — run evaluations

Runs evaluation files. With no file argument it runs everything in the `evals/` directory matching `*_eval.py` / `eval_*.py` (Python) or the project's eval files (TS).

```bash
# TypeScript
npx lmnr eval                     # all evals in ./evals
npx lmnr eval my-eval.ts

# Python
lmnr eval                         # all evals in ./evals
lmnr eval my_eval.py
lmnr eval --continue-on-error --output-file results.json
```

### dev — debugger

Same interactive debugger as `lmnr-cli dev`, available from the SDK install.

```bash
lmnr dev agent.py --function my_agent
```

### datasets

The SDK-bundled CLI also exposes the dataset workflow (`list`, `create`, `push`, `pull`). Note the bundled command uses the `datasets` (plural) noun:

```bash
npx lmnr datasets list                              # TypeScript
lmnr datasets list                                   # Python
npx lmnr datasets create my-dataset data.json -o my-dataset.json
npx lmnr datasets push -n my-dataset my-dataset.json
npx lmnr datasets pull -n my-dataset my-dataset.json
```

Common options: `--project-api-key <key>`, `--base-url <url>` (no port), `--port <port>` (443 default, 8000 for local). `push`/`pull` take `-n <name>` or `--id <id>`; `create`/`push`/`pull` accept `--batch-size` (default 100) and `-r`/`--recursive`. Datapoint `id` fields drive versioning — never edit them in local files. Deleting a datapoint locally does not delete it in Laminar; `push` only adds new datapoint versions.

### add-cursor-rules (Python SDK)

Downloads `laminar.mdc` into `.cursor/rules/` so Cursor gives Laminar-aware completions:

```bash
pip install 'lmnr[all]'
lmnr add-cursor-rules
# then reload Cursor: Cmd+Shift+P -> "Reload Window"
```
