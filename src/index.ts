import { Laminar, registerAiSdkTelemetry } from "@lmnr-ai/lmnr";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createAgent } from "./agent";
import { startAskServer } from "./channels/ask";
import { cli } from "./channels/cli";
import { telegram } from "./channels/telegram";
import { conversationsDir, remindersDir, WORKSPACE_ROOT } from "./config";

Laminar.initialize({
  projectApiKey: process.env.LMNR_PROJECT_API_KEY,
  ...(process.env.LMNR_BASE_URL && {
    baseUrl: process.env.LMNR_BASE_URL,
    httpPort: Number(process.env.LMNR_HTTP_PORT) ?? undefined,
    grpcPort: Number(process.env.LMNR_GRPC_PORT) ?? undefined,
    disableBatch: true,
  }),
});

registerAiSdkTelemetry();

await mkdir(WORKSPACE_ROOT, { recursive: true });
await mkdir(conversationsDir, { recursive: true });
await mkdir(remindersDir, { recursive: true });

const { values } = parseArgs({ options: { mode: { type: "string" } } });
const mode = values.mode;

if (mode === telegram.name) {
  const agent = await telegram.start(createAgent);
  // Voice front-end: shares the same agent (memory, mutex, reminders).
  if (agent && process.env.ASK_TOKEN)
    startAskServer(agent, {
      token: process.env.ASK_TOKEN,
      port: Number(process.env.ASK_PORT ?? 8788),
    });
} else if (mode === cli.name) cli.start(createAgent);
else {
  console.error(`Specify --mode ${telegram.name} or ${cli.name}`);
  process.exit(1);
}
