import { z } from "zod";
import type { SendFile } from "./tools";

export type Agent = {
  runTurn: (message: string) => Promise<void>;
  syncReminders: () => Promise<void>;
  ask: (text: string) => Promise<{ speak: string; actions: unknown[] }>;
};
export type Deliver = (stream: AsyncIterable<string>) => Promise<void>;
export type CreateAgent = (deliver: Deliver, sendFile: SendFile) => Agent;

export const reminderSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("repeating"), cron: z.string() }),
    z.object({ type: z.literal("absolute"), at: z.string() }),
  ])
  .and(z.object({ prompt: z.string(), tz: z.string().optional() }));

export type Reminder = z.infer<typeof reminderSchema>;

export interface Channel {
  name: string;
  start(createAgent: CreateAgent): Promise<Agent | void>;
}
