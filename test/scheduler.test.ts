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
  process.env.DRY_RUN = "false";
  process.env.MAX_FOUNDERS_PER_RUN = "4";
  process.env.RUN_INTERVAL_HOURS = "3";
  process.env.MAX_RUNTIME_HOURS = "48";
  process.env.MAX_API_SPEND_USD = "2.00";
  clearCachedConfig();
}

test("HermesScheduler retries unsent founders and skips duplicates within a run", async () => {
  configureEnv();
  process.env.LLM_PARSE_MAX_PER_RUN = "10";
  clearCachedConfig();
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
    batch: "Spring 2026",
    source: "yc_directory",
    sentAt: null,
    createdAt: now.toISOString(),
  };

  const duplicateCandidate: RawCandidate = {
    source: "hn_launch",
    rawText: "Launch HN: Fresh Labs AI developer tooling",
    founderName: null,
    companyName: "Fresh Labs",
    companyDescription: "AI developer tooling",
    website: "https://freshlabs.ai",
    ycProfileUrl: null,
    twitterHandle: null,
    batch: "Spring 2026",
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
    scrapeStartupWhoAccelerators: async () => [],
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
      batch: "Spring 2026",
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

test("HermesScheduler stops before scraping when API spend limit is reached", async () => {
  configureEnv();
  process.env.MAX_API_SPEND_USD = "0.01";
  clearCachedConfig();

  closeDb();
  initDb(createTempDbPath());

  const now = new Date("2026-01-01T00:00:00.000Z");
  initializeRuntimeWindowState(database, now);

  insertFounder({
    founderName: "Existing Founder",
    companyName: "Existing Co",
    companyDescription: "Already found",
    linkedinUrl: null,
    twitterUrl: null,
    twitterHandle: null,
    email: null,
    website: "https://existing.example",
    ycProfileUrl: null,
    batch: "S25",
    source: "yc_directory",
    sentAt: now.toISOString(),
    createdAt: now.toISOString(),
  });

  database.logApiUsage(1_000_000, 1_000_000);

  const alerts: string[] = [];
  const exitCodes: number[] = [];

  const scheduler = new HermesScheduler({
    db: database,
    telegram: {
      sendRunStartMessage: async () => true,
      sendRunEndMessage: async () => true,
      sendFounder: async () => true,
      sendStartupMessage: async () => true,
      sendShutdownMessage: async () => true,
      sendSpendLimitReachedMessage: async (
        limitUsd: number,
        totalFounders: number,
      ) => {
        alerts.push(`$${limitUsd.toFixed(2)}|${totalFounders}`);
        return true;
      },
    } as never,
    scrapeYcDirectory: async () => {
      throw new Error("scrapeYcDirectory should not run");
    },
    scrapeStartupWhoAccelerators: async () => {
      throw new Error("scrapeStartupWhoAccelerators should not run");
    },
    scrapeHnLaunchPosts: async () => {
      throw new Error("scrapeHnLaunchPosts should not run");
    },
    scrapeNitterPosts: async () => {
      throw new Error("scrapeNitterPosts should not run");
    },
    scrapeProductHunt: async () => {
      throw new Error("scrapeProductHunt should not run");
    },
    parseRawCandidate: async () => {
      throw new Error("parseRawCandidate should not run");
    },
    enrichFounderProfile: async (founder) => founder,
    now: () => now,
    exitProcess: (code) => {
      exitCodes.push(code);
    },
  });

  await scheduler.start();

  assert.deepEqual(alerts, ["$0.01|1"]);
  assert.deepEqual(exitCodes, [0]);
  closeDb();
});

test("HermesScheduler dry run scrapes YC only, parses and enriches three founders, sends one founder, and exits", async () => {
  configureEnv();
  process.env.DRY_RUN = "true";
  clearCachedConfig();

  closeDb();
  initDb(createTempDbPath());

  const now = new Date("2026-01-01T00:00:00.000Z");
  initializeRuntimeWindowState(database, now);
  const ycFounders: Founder[] = Array.from({ length: 3 }, (_value, index) => ({
    founderName: `Founder ${index + 1}`,
    companyName: `Company ${index + 1}`,
    companyDescription: `AI developer infrastructure for Company ${index + 1}`,
    linkedinUrl: null,
    twitterUrl: null,
    twitterHandle: null,
    email: null,
    website: `https://company-${index + 1}.example`,
    ycProfileUrl: `https://www.ycombinator.com/companies/company-${index + 1}`,
    batch: "Spring 2026",
    source: "yc_directory",
    sentAt: null,
    createdAt: now.toISOString(),
  }));

  const parsedCandidates: RawCandidate[] = [];
  const enrichedFounders: Founder[] = [];
  const delivered: string[] = [];
  const exitCodes: number[] = [];

  const scheduler = new HermesScheduler({
    db: database,
    telegram: {
      sendRunStartMessage: async () => {
        throw new Error("sendRunStartMessage should not run in dry run");
      },
      sendRunEndMessage: async () => {
        throw new Error("sendRunEndMessage should not run in dry run");
      },
      sendFounder: async (founder: Founder) => {
        delivered.push(`${founder.founderName}|${founder.companyName}`);
        return true;
      },
      sendStartupMessage: async () => true,
      sendShutdownMessage: async () => true,
      sendSpendLimitReachedMessage: async () => true,
    } as never,
    scrapeYcDirectory: async (options) => {
      assert.equal(options?.maxResults, 3);
      assert.equal(options?.dryRun, true);
      return ycFounders;
    },
    scrapeStartupWhoAccelerators: async () => {
      throw new Error("scrapeStartupWhoAccelerators should not run in dry run");
    },
    scrapeHnLaunchPosts: async () => {
      throw new Error("scrapeHnLaunchPosts should not run in dry run");
    },
    scrapeNitterPosts: async () => {
      throw new Error("scrapeNitterPosts should not run in dry run");
    },
    scrapeProductHunt: async () => {
      throw new Error("scrapeProductHunt should not run in dry run");
    },
    parseRawCandidate: async (candidate) => {
      parsedCandidates.push(candidate);
      throw new Error("parseRawCandidate should not run for structured dry run");
    },
    enrichFounderProfile: async (founder) => {
      enrichedFounders.push(founder);
      return {
        ...founder,
        linkedinUrl: `https://www.linkedin.com/in/${founder.founderName
          .toLowerCase()
          .replace(/\s+/g, "-")}`,
      };
    },
    now: () => now,
    exitProcess: (code) => {
      exitCodes.push(code);
    },
  });

  await scheduler.start();

  assert.equal(parsedCandidates.length, 0);
  assert.equal(enrichedFounders.length, 3);
  assert.deepEqual(delivered, ["Founder 1|Company 1"]);
  assert.deepEqual(exitCodes, [0]);
  closeDb();
});

test("HermesScheduler dry run tries public structured sources when YC returns no usable founders", async () => {
  configureEnv();
  process.env.DRY_RUN = "true";
  clearCachedConfig();

  closeDb();
  initDb(createTempDbPath());

  const now = new Date("2026-01-01T00:00:00.000Z");
  initializeRuntimeWindowState(database, now);
  const publicFounder: Founder = {
    founderName: "Hannah Fallback",
    companyName: "Fallback Labs",
    companyDescription: "AI developer discovery tooling",
    linkedinUrl: "https://www.linkedin.com/in/hannah-fallback",
    twitterUrl: null,
    twitterHandle: null,
    email: null,
    website: "https://fallback.example",
    ycProfileUrl: null,
    sourceProfileUrl: "https://www.startupwho.com/startups?source=techstars",
    fundingSource: "Techstars",
    fundingDate: null,
    fundingRound: "Spring 2026",
    techCategory: "AI",
    careersUrl: null,
    engineeringHiringSignal: false,
    batch: "Spring 2026",
    source: "techstars",
    sentAt: null,
    createdAt: now.toISOString(),
  };

  const parsedCandidates: RawCandidate[] = [];
  const delivered: string[] = [];
  const exitCodes: number[] = [];

  const scheduler = new HermesScheduler({
    db: database,
    telegram: {
      sendRunStartMessage: async () => {
        throw new Error("sendRunStartMessage should not run in dry run");
      },
      sendRunEndMessage: async () => {
        throw new Error("sendRunEndMessage should not run in dry run");
      },
      sendFounder: async (founder: Founder) => {
        delivered.push(`${founder.founderName}|${founder.companyName}`);
        return true;
      },
      sendStartupMessage: async () => true,
      sendShutdownMessage: async () => true,
      sendSpendLimitReachedMessage: async () => true,
    } as never,
    scrapeYcDirectory: async () => [],
    scrapeStartupWhoAccelerators: async () => [publicFounder],
    scrapeHnLaunchPosts: async () => {
      throw new Error("scrapeHnLaunchPosts should not run after public source succeeds");
    },
    scrapeNitterPosts: async () => {
      throw new Error("scrapeNitterPosts should not run after public source succeeds");
    },
    scrapeProductHunt: async () => {
      throw new Error("scrapeProductHunt should not run after public source succeeds");
    },
    parseRawCandidate: async (candidate) => {
      parsedCandidates.push(candidate);
      throw new Error("parseRawCandidate should not run when public source succeeds");
    },
    enrichFounderProfile: async (founder) => founder,
    now: () => now,
    exitProcess: (code) => {
      exitCodes.push(code);
    },
  });

  await scheduler.start();

  assert.deepEqual(
    parsedCandidates.map((candidate) => candidate.source),
    [],
  );
  assert.deepEqual(delivered, ["Hannah Fallback|Fallback Labs"]);
  assert.deepEqual(exitCodes, [0]);
  closeDb();
});

test("HermesScheduler dry run fails only after all sources return zero", async () => {
  configureEnv();
  process.env.DRY_RUN = "true";
  clearCachedConfig();

  closeDb();
  initDb(createTempDbPath());

  const now = new Date("2026-01-01T00:00:00.000Z");
  initializeRuntimeWindowState(database, now);
  const delivered: string[] = [];
  const exitCodes: number[] = [];

  const scheduler = new HermesScheduler({
    db: database,
    telegram: {
      sendRunStartMessage: async () => {
        throw new Error("sendRunStartMessage should not run in dry run");
      },
      sendRunEndMessage: async () => {
        throw new Error("sendRunEndMessage should not run in dry run");
      },
      sendFounder: async (founder: Founder) => {
        delivered.push(`${founder.founderName}|${founder.companyName}`);
        return true;
      },
      sendStartupMessage: async () => true,
      sendShutdownMessage: async () => true,
      sendSpendLimitReachedMessage: async () => true,
    } as never,
    scrapeYcDirectory: async () => [],
    scrapeStartupWhoAccelerators: async () => [],
    scrapeHnLaunchPosts: async () => [],
    scrapeNitterPosts: async () => [],
    scrapeProductHunt: async () => [],
    parseRawCandidate: async () => {
      throw new Error("parseRawCandidate should not run with zero candidates");
    },
    enrichFounderProfile: async (founder) => founder,
    now: () => now,
    exitProcess: (code) => {
      exitCodes.push(code);
    },
  });

  await scheduler.start();

  assert.deepEqual(delivered, []);
  assert.deepEqual(exitCodes, [1]);
  closeDb();
});
