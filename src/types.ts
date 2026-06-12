import { z } from "zod";

// Single source of truth for the reminder shape — syncReminders validates
// agent-written entries against this, and the prompt's REMINDERS section
// must describe the same shape.
export const reminderSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("repeating"), cron: z.string() }),
    z.object({ type: z.literal("absolute"), at: z.string() }),
  ])
  .and(z.object({ id: z.string(), prompt: z.string(), tz: z.string().optional() }));

export type Reminder = z.infer<typeof reminderSchema>;
