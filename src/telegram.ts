import TelegramBot from "node-telegram-bot-api";

import { config } from "./config.js";
import { logger } from "./logger.js";
import type { Founder, RunStats } from "./types.js";

export interface TelegramBotLike {
  sendMessage(chatId: string, text: string): Promise<unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function formatFounderMessage(founder: Founder): string {
  return [
    `🚀 New Founder Found — ${founder.batch ?? "Unknown"} Batch`,
    `👤 Name: ${founder.founderName}`,
    `🏢 Company: ${founder.companyName}`,
    `📝 About: ${founder.companyDescription ?? "Not found"}`,
    `🔗 LinkedIn: ${founder.linkedinUrl ?? "Not found"}`,
    `🐦 Twitter: ${founder.twitterUrl ?? "Not found"}`,
    `📧 Email: ${founder.email ?? "Not found"}`,
    `🌐 Website: ${founder.website ?? "Not found"}`,
    `📌 YC Profile: ${founder.ycProfileUrl ?? founder.website ?? "Not found"}`,
    `📡 Source: ${founder.source}`,
    `⏰ Found: ${founder.createdAt}`,
  ].join("\n");
}

function formatRunStartMessage(runId: number): string {
  return `🤖 Hermes Agent started run #${runId} — searching for founders...`;
}

function formatRunEndMessage(runId: number, stats: RunStats): string {
  return `✅ Run #${runId} complete — Found: ${stats.foundersFound} | Sent: ${stats.foundersSent} | Skipped: ${stats.duplicatesSkipped} duplicates`;
}

export class TelegramService {
  private lastFounderSentAt = 0;

  public constructor(
    private readonly bot: TelegramBotLike,
    private readonly chatId: string,
    private readonly sleepFn: (ms: number) => Promise<void> = sleep,
  ) {}

  private async send(text: string): Promise<boolean> {
    try {
      await this.bot.sendMessage(this.chatId, text);
      return true;
    } catch (error) {
      logger.error(
        `Telegram send failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async applyFounderThrottle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastFounderSentAt;

    if (elapsed < 2000) {
      await this.sleepFn(2000 - elapsed);
    }

    this.lastFounderSentAt = Date.now();
  }

  public async sendStartupMessage(
    runIntervalHours: number,
    maxRuntimeHours: number,
  ): Promise<boolean> {
    return this.send(
      `🚀 Hermes Agent is live! Will run every ${runIntervalHours}h for ${maxRuntimeHours}h. Let's find some founders.`,
    );
  }

  public async sendShutdownMessage(): Promise<boolean> {
    return this.send("🛑 Hermes Agent is shutting down gracefully.");
  }

  public async sendRunStartMessage(runId: number): Promise<boolean> {
    return this.send(formatRunStartMessage(runId));
  }

  public async sendRunEndMessage(
    runId: number,
    stats: RunStats,
  ): Promise<boolean> {
    return this.send(formatRunEndMessage(runId, stats));
  }

  public async sendFounder(founder: Founder): Promise<boolean> {
    await this.applyFounderThrottle();
    return this.send(formatFounderMessage(founder));
  }
}

export function createTelegramService(
  bot?: TelegramBotLike,
  chatId = config.TELEGRAM_CHAT_ID,
): TelegramService {
  const telegramBot =
    bot ?? new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: false });

  return new TelegramService(telegramBot, chatId);
}
