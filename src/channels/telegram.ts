import { randomInt } from "node:crypto";
import {
  autoChatAction,
  type AutoChatActionFlavor,
} from "@grammyjs/auto-chat-action";
import { autoRetry } from "@grammyjs/auto-retry";
import { streamApi } from "@grammyjs/stream";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { Laminar } from "@lmnr-ai/lmnr";
import { Bot, InputFile, type Context } from "grammy";
import type { Channel } from "../types";

type BotContext = Context & AutoChatActionFlavor;

export const telegram: Channel = {
  name: "telegram",
  start: async (createAgent) => {
    const chatId = Number(process.env.TELEGRAM_CHAT_ID);
    if (!Number.isFinite(chatId))
      throw new Error("set TELEGRAM_CHAT_ID env var (your chat id)");
    const bot = new Bot<BotContext>(process.env.TELEGRAM_TOKEN!);
    bot.api.config.use(autoRetry({ maxDelaySeconds: 5, maxRetryAttempts: 3 }));
    bot.api.config.use(apiThrottler());
    bot.use(autoChatAction());
    const streamer = streamApi(bot.api.raw);
    const newDraftId = () => randomInt(1, 2 ** 48);
    const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp"];
    const agent = createAgent(
      (stream) =>
        streamer.streamMarkdown(chatId, newDraftId(), stream).then(() => {}),
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
      if (ctx.chat.id !== chatId) return; // ignore non-owner messages
      ctx.chatAction = "typing"; // auto-refreshed until the handler returns
      await agent.runTurn(ctx.message.text);
    });
    await agent.syncReminders();
    const shutdown = async () => {
      await bot.stop();
      await Laminar.shutdown();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    bot.start();
    return agent;
  },
};
