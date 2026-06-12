# Quickstart: a trace in minutes

The smallest runnable demo that produces a trace with no external LLM calls. Tag the trace with a unique run id so it's easy to find in the UI. Pick the language, run it, then open **Traces** and filter by tag `quickstart` or metadata `run_id`.

## Node / TypeScript

```bash
npm init -y
npm install @lmnr-ai/lmnr
export LMNR_PROJECT_API_KEY=<your-key>
```

`quickstart.mjs` (use `.mjs` or set `"type": "module"` in `package.json`):

```js
import { Laminar, observe } from '@lmnr-ai/lmnr';

Laminar.initialize({
  projectApiKey: process.env.LMNR_PROJECT_API_KEY,
  instrumentModules: {},
  disableBatch: true,
  // Self-hosted: baseUrl: 'http://localhost', httpPort: 8000, grpcPort: 8001,
});

const runId = `quickstart-${Date.now()}`;

const result = await observe(
  { name: 'quickstart.root', tags: ['quickstart', runId], metadata: { run_id: runId } },
  async () => {
    const step = await observe({ name: 'quickstart.step' }, async () => ({ answer: 42 }));
    return { step };
  },
);

console.log('Run id:', runId, 'Result:', result);
await Laminar.flush(); // REQUIRED in short-lived scripts; the await matters
```

Run: `node quickstart.mjs`

## Python

```bash
pip install lmnr
export LMNR_PROJECT_API_KEY=<your-key>
```

`quickstart.py`:

```python
import os, time
from lmnr import Laminar, observe

Laminar.initialize(
    project_api_key=os.environ["LMNR_PROJECT_API_KEY"],
    instruments=set(),
    disable_batch=True,
    # Self-hosted: base_url="http://localhost", http_port=8000, grpc_port=8001,
)

run_id = f"quickstart-{int(time.time())}"

@observe(name="quickstart.root", tags=["quickstart", run_id], metadata={"run_id": run_id})
def main():
    @observe(name="quickstart.step")
    def step():
        return {"answer": 42}
    return {"step": step()}

if __name__ == "__main__":
    print("Run id:", run_id, "Result:", main())
    Laminar.flush()  # REQUIRED in short-lived scripts
```

Run: `python quickstart.py`

## Troubleshooting

- **No traces at all:** verify `LMNR_PROJECT_API_KEY`. For self-hosted, pass `baseUrl`/`base_url` with the correct ports (HTTP `8000`, gRPC `8001`).
- **Trace delayed or missing in a short script:** set `disableBatch`/`disable_batch` and call `flush()`; keep the process alive a moment.
- **Can't find the trace:** filter by tag `quickstart` or metadata key `run_id`.
- **Self-hosted UI shows no data:** confirm backend services are running and reachable on the HTTP/gRPC ports.

For real codebases (auto-instrumentation, framework setup, context, privacy), use `references/instrumentation-typescript.md` or `references/instrumentation-python.md` instead.
