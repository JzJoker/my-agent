import { Laminar } from "@lmnr-ai/lmnr";
import { execa } from "execa";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { createAgent } from "./agent";
import { cli } from "./channels/cli";
import { telegram } from "./channels/telegram";
import type { Channel } from "./channels/types";
import { conversationsDir, DATA_DIR, memoryDir, remindersDir } from "./config";

Laminar.initialize({
  projectApiKey: process.env.LMNR_PROJECT_API_KEY,
  ...(process.env.LMNR_BASE_URL && {
    baseUrl: process.env.LMNR_BASE_URL,
    httpPort: Number(process.env.LMNR_HTTP_PORT) ?? undefined,
    grpcPort: Number(process.env.LMNR_GRPC_PORT) ?? undefined,
  }),
});

await mkdir(conversationsDir, { recursive: true });
await mkdir(memoryDir, { recursive: true });
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

const {
  values: { mode },
} = parseArgs({ options: { mode: { type: "string" } } });

const channels: Record<string, Channel> = {
  [telegram.name]: telegram,
  [cli.name]: cli,
};

const channel = mode ? channels[mode] : undefined;
if (!channel) {
  console.error(`Specify --mode ${Object.keys(channels).join(" or ")}`);
  process.exit(1);
}
await channel.start(createAgent);
