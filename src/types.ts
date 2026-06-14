import { z } from "zod";

// Single source of truth for the reminder shape. Each reminder is one YAML file
// at /reminders/<id>.yaml — the filename is the id, so it isn't in the body.
// syncReminders validates against this; the prompt's REMINDERS section must
// describe the same shape.
export const reminderSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("repeating"), cron: z.string() }),
    z.object({ type: z.literal("absolute"), at: z.string() }),
  ])
  .and(z.object({ prompt: z.string(), tz: z.string().optional() }));

export type Reminder = z.infer<typeof reminderSchema>;
