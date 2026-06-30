import { tool } from "ai";
import mqtt from "mqtt";
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { WORKSPACE_ROOT } from "../config";

type SendFile = (absolutePath: string, caption?: string) => Promise<void>;

const SNAPSHOT_URL =
  process.env.GO2RTC_SNAPSHOT_URL ??
  "http://bambu-go2rtc:1984/api/frame.jpeg?src=bambu_camera";

type PrintStatus = {
  state?: string; // RUNNING / PAUSE / FINISH / FAILED / IDLE / PREPARE
  percent?: number;
  layer?: number;
  total_layers?: number;
  remaining_min?: number;
  file?: string;
  nozzle_temp?: number;
  bed_temp?: number;
};

const getPrintStatus = (): Promise<PrintStatus | { error: string }> => {
  const host = process.env.PRINTER_ADDRESS;
  const code = process.env.PRINTER_ACCESS_CODE;
  const serial = process.env.PRINTER_SERIAL;
  if (!host || !code || !serial)
    return Promise.resolve({
      error: "printer telemetry not configured (PRINTER_ADDRESS/ACCESS_CODE/SERIAL)",
    });

  return new Promise((resolve) => {
    const client = mqtt.connect(`mqtts://${host}:8883`, {
      username: "bblp",
      password: code,
      rejectUnauthorized: false, // printer presents a self-signed cert
      connectTimeout: 5000,
      reconnectPeriod: 0,
    });
    const state: any = {};
    let done = false;
    const finish = (result: PrintStatus | { error: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        client.end(true);
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ error: "printer did not respond (MQTT timeout)" }),
      8000,
    );
    client.on("connect", () => {
      client.subscribe(`device/${serial}/report`);
      client.publish(
        `device/${serial}/request`,
        JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }),
      );
    });
    client.on("message", (_t, payload) => {
      try {
        const pl = JSON.parse(payload.toString());
        if (pl.print) Object.assign(state, pl.print);
      } catch {}
      if (state.gcode_state !== undefined)
        finish({
          state: state.gcode_state,
          percent: state.mc_percent,
          layer: state.layer_num,
          total_layers: state.total_layer_num,
          remaining_min: state.mc_remaining_time,
          file: state.subtask_name || state.gcode_file,
          nozzle_temp: state.nozzle_temper,
          bed_temp: state.bed_temper,
        });
    });
    client.on("error", (e: any) => finish({ error: `MQTT error: ${e?.message ?? e}` }));
  });
};

const describeImage = async (
  base64: string,
  status: PrintStatus | { error: string },
  question?: string,
) => {
  const baseURL = process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1";
  const ground =
    "error" in status
      ? ""
      : `\n\nGround truth from the printer's own telemetry (trust this for run state, not your eyes): ` +
        `state=${status.state}, ${status.percent}% done, layer ${status.layer}/${status.total_layers}, ` +
        `~${status.remaining_min} min left, file "${status.file}". Describe what you SEE in the photo and any problems.`;
  const ask = question
    ? `${question}`
    : "This is a live camera snapshot of my Bambu Lab A1 3D printer's build plate. " +
      "How does the print look — any spaghetti/stringing, warping, layer shift, detachment, or blobs? Keep it brief.";
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MOONSHOT_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.AGENT_MODEL ?? "kimi-k2.6",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: ask + ground },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`vision call failed: HTTP ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "(model returned no description)";
};

export const check_print = tool({
  description:
    "Check on the 3D printer. Returns the printer's exact status from its own telemetry — " +
    "whether it's printing/paused/finished/failed/idle, plus percent done, current/total layer, " +
    "time remaining, file name, and temps — AND sends the live camera snapshot to the user with a " +
    "visual read of the print (spaghetti, warping, etc.). Use this whenever the user asks about " +
    "their print or printer (e.g. 'is it still going?', 'is it done?', 'how's it look?'). Pass the " +
    "user's specific question if they have one.",
  inputSchema: z.object({
    question: z
      .string()
      .optional()
      .describe("The user's specific question about the print, if any."),
  }),
  contextSchema: z.custom<{ sendFile: SendFile }>(),
  execute: async ({ question }, { context }) => {
    // Telemetry first — it's the ground truth and works even if the camera is down.
    const status = await getPrintStatus();

    let buf: Buffer | undefined;
    try {
      const res = await fetch(SNAPSHOT_URL);
      if (res.ok) buf = Buffer.from(await res.arrayBuffer());
    } catch {}
    if (!buf)
      return { status, photo_sent: false, error: "couldn't reach the printer camera" };

    let photo_sent = false;
    try {
      const path = join(WORKSPACE_ROOT, ".cache", "print-snapshot.jpg");
      await mkdir(dirname(path), { recursive: true });
      await fsWriteFile(path, buf);
      await context.sendFile(path, "Current print 📷");
      photo_sent = true;
    } catch {}

    try {
      const description = await describeImage(buf.toString("base64"), status, question);
      return { status, photo_sent, description };
    } catch (e: any) {
      return { status, photo_sent, error: `couldn't analyze the snapshot: ${e?.message ?? e}` };
    }
  },
});
