import {
  autoChatAction,
  type AutoChatActionFlavor,
} from "@grammyjs/auto-chat-action";
import { autoRetry } from "@grammyjs/auto-retry";
import { streamApi } from "@grammyjs/stream";
import { Laminar } from "@lmnr-ai/lmnr";
import { Bot, InputFile, type Context } from "grammy";
import type { Channel } from "./types";

type BotContext = Context & AutoChatActionFlavor;

export const telegram: Channel = {
  name: "telegram",
  start: async (createAgent) => {
    const chatId = Number(process.env.TELEGRAM_CHAT_ID);
    if (!Number.isFinite(chatId)) {
      console.error(
        "TELEGRAM_CHAT_ID is required in telegram mode (your chat id).",
      );
      process.exit(1);
    }
    const bot = new Bot<BotContext>(process.env.TELEGRAM_TOKEN!);
    bot.api.config.use(autoRetry()); // turn rate limits into slower calls
    bot.use(autoChatAction());
    // @grammyjs/stream renders the delta stream into a live-updating message
    // (draft edits while streaming, final markdown when done, 4096 split).
    const streamer = streamApi(bot.api.raw);
    let draftId = 1;
    // Images go as photos (inline preview); everything else as a document.
    const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp"];
    const { runTurn, syncReminders } = createAgent(
      (stream) =>
        streamer.streamMarkdown(chatId, draftId++, stream).then(() => {}),
      (absPath, caption) => {
        const file = new InputFile(absPath);
        const opts = caption ? { caption } : {};
        const ext = absPath.toLowerCase().split(".").pop() ?? "";
        const sent = IMAGE_EXT.includes(ext)
          ? bot.api.sendPhoto(chatId, file, opts)
          : bot.api.sendDocument(chatId, file, opts);
        return sent.then(() => {});
      },
    );
    bot.on("message:text", async (ctx) => {
      if (ctx.chat.id !== chatId) return; // ignore anyone who isn't the owner
      ctx.chatAction = "typing"; // auto-refreshed until the handler returns
      await runTurn(ctx.message.text);
    });
    await syncReminders();
    const shutdown = async () => {
      await bot.stop();
      await Laminar.shutdown();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    bot.start();
  },
};
