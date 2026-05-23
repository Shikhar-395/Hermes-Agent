import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { clearCachedConfig } from "../src/config.js";
import {
  closeDb,
  database,
  getStats,
  getUnsentFounders,
  initDb,
  insertFounder,
} from "../src/database.js";
import { HermesScheduler, initializeRuntimeWindowState } from "../src/scheduler.js";
import type { Founder, RawCandidate } from "../src/types.js";

function createTempDbPath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "hermes-scheduler-"));
  return path.join(directory, "hermes.sqlite");
}

function configureEnv(): void {
  process.env.DEEPSEEK_API_KEY = "deepseek-key";
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_CHAT_ID = "12345";
  process.env.HUNTER_API_KEY = "hunter-key";
  process.env.MAX_FOUNDERS_PER_RUN = "4";
  process.env.RUN_INTERVAL_HOURS = "3";
  process.env.MAX_RUNTIME_HOURS = "48";
  clearCachedConfig();
}

test("HermesScheduler retries unsent founders and skips duplicates within a run", async () => {
  configureEnv();
  closeDb();
  initDb(createTempDbPath());

  const now = new Date("2026-01-01T00:00:00.000Z");
  initializeRuntimeWindowState(database, now);

  insertFounder({
    founderName: "Queued Founder",
    companyName: "Queued Co",
    companyDescription: "Queued profile",
    linkedinUrl: null,
    twitterUrl: null,
    twitterHandle: null,
    email: null,
    website: "https://queued.example",
    ycProfileUrl: null,
    batch: "S25",
    source: "yc_directory",
    sentAt: null,
    createdAt: now.toISOString(),
  });

  const delivered: string[] = [];
  const ycFounder: Founder = {
    founderName: "Fresh Founder",
    companyName: "Fresh Labs",
    companyDescription: "New AI tooling",
    linkedinUrl: null,
    twitterUrl: null,
    twitterHandle: null,
    email: null,
    website: "https://freshlabs.ai",
    ycProfileUrl: "https://www.ycombinator.com/companies/fresh-labs",
    batch: "S25",
    source: "yc_directory",
    sentAt: null,
    createdAt: now.toISOString(),
  };

  const duplicateCandidate: RawCandidate = {
    source: "hn_launch",
    rawText: "Launch HN: Fresh Labs",
    founderName: null,
    companyName: "Fresh Labs",
    companyDescription: null,
    website: "https://freshlabs.ai",
    ycProfileUrl: null,
    twitterHandle: null,
    batch: "S25",
  };

  const scheduler = new HermesScheduler({
    db: database,
    telegram: {
      sendRunStartMessage: async () => true,
      sendRunEndMessage: async () => true,
      sendFounder: async (founder: Founder) => {
        delivered.push(`${founder.founderName}|${founder.companyName}`);
        return true;
      },
      sendStartupMessage: async () => true,
      sendShutdownMessage: async () => true,
    } as never,
    scrapeYcDirectory: async () => [ycFounder],
    scrapeHnLaunchPosts: async () => [duplicateCandidate],
    scrapeNitterPosts: async () => [],
    scrapeProductHunt: async () => [],
    parseRawCandidate: async () => ({
      founderName: "Fresh Founder",
      companyName: "Fresh Labs",
      companyDescription: "New AI tooling",
      linkedinUrl: null,
      twitterHandle: null,
      website: "https://freshlabs.ai",
      ycProfileUrl: null,
      batch: "S25",
      isFounder: true,
    }),
    enrichFounderProfile: async (founder) => ({
      ...founder,
      linkedinUrl: "https://www.linkedin.com/in/fresh-founder",
      twitterUrl: "https://twitter.com/freshfounder",
      email: "fresh@freshlabs.ai",
    }),
    now: () => now,
  });

  await scheduler.start();
  await scheduler.stop("test");

  assert.deepEqual(delivered, [
    "Queued Founder|Queued Co",
    "Fresh Founder|Fresh Labs",
  ]);

  assert.equal(getUnsentFounders().length, 0);
  assert.deepEqual(getStats(), {
    startedAt: now.toISOString(),
    foundersFound: 1,
    foundersSent: 2,
    duplicatesSkipped: 1,
    errors: 0,
  });

  closeDb();
});
