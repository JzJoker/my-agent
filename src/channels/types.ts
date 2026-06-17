import type { CreateAgent } from "../agent";

/**
 * A delivery surface (Telegram, CLI, …). Each channel owns how it receives
 * input and how it sends the agent's output back; `start` builds an agent via
 * the injected `createAgent` — passing its own delivery function — wires the
 * surface to it, and runs until the process exits.
 */
export interface Channel {
  /** Selects this channel; matched against the --mode flag. */
  name: string;
  start(createAgent: CreateAgent): Promise<void>;
}
