import { autoChatAction, type AutoChatActionFlavor } from "@grammyjs/auto-chat-action";
import { Laminar } from "@lmnr-ai/lmnr";
import { Bot, type Context } from "grammy";
import telegramify from "telegramify-markdown";
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
    bot.use(autoChatAction());
    const markdownText = (text: string) =>
      telegramify(text.slice(0, 4096), "escape");
    const { runTurn, syncReminders } = createAgent(async (text) => {
      await bot.api.sendMessage(chatId, markdownText(text), {
        parse_mode: "MarkdownV2",
      });
    });
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
