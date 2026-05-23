import cron, { type ScheduledTask } from "node-cron";

import { config } from "./config.js";
import type { DatabaseAdapter } from "./database.js";
import { database } from "./database.js";
import { enrichFounderProfile } from "./enricher.js";
import { logger } from "./logger.js";
import { parseRawCandidate } from "./parser.js";
import {
  scrapeHnLaunchPosts,
  scrapeNitterPosts,
  scrapeProductHunt,
  scrapeYcDirectory,
} from "./scraper.js";
import { createTelegramService, type TelegramService } from "./telegram.js";
import type {
  Founder,
  RawCandidate,
  ScraperSource,
  SourceQuotaMap,
} from "./types.js";

const SOURCE_PRIORITY: ScraperSource[] = [
  "yc_directory",
  "hn_launch",
  "twitter",
  "producthunt",
];

const SOURCE_WEIGHTS: Record<ScraperSource, number> = {
  yc_directory: 0.4,
  hn_launch: 0.25,
  twitter: 0.2,
  producthunt: 0.15,
};

const RUNTIME_STARTED_AT_KEY = "runtime_started_at";
const RUNTIME_COMPLETED_AT_KEY = "runtime_completed_at";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeWebsite(value: string | null | undefined): string {
  return normalizeText(value).replace(/\/+$/, "");
}

export function buildCronExpression(intervalHours: number): string {
  if (intervalHours <= 0) {
    return "0 */3 * * *";
  }

  if (intervalHours < 24) {
    return `0 */${intervalHours} * * *`;
  }

  if (intervalHours === 24) {
    return "0 0 * * *";
  }

  if (intervalHours % 24 === 0) {
    return `0 0 */${intervalHours / 24} * *`;
  }

  return "0 * * * *";
}

export function buildSourceQuotas(maxFounders: number): SourceQuotaMap {
  const base: SourceQuotaMap = {
    yc_directory: Math.floor(maxFounders * SOURCE_WEIGHTS.yc_directory),
    hn_launch: Math.floor(maxFounders * SOURCE_WEIGHTS.hn_launch),
    twitter: Math.floor(maxFounders * SOURCE_WEIGHTS.twitter),
    producthunt: Math.floor(maxFounders * SOURCE_WEIGHTS.producthunt),
  };

  let allocated =
    base.yc_directory + base.hn_launch + base.twitter + base.producthunt;

  for (const source of SOURCE_PRIORITY) {
    if (allocated >= maxFounders) {
      break;
    }

    base[source] += 1;
    allocated += 1;
  }

  return base;
}

export function hasRuntimeExpired(
  startedAt: string,
  maxRuntimeHours: number,
  now = new Date(),
): boolean {
  const startedAtTime = new Date(startedAt).getTime();
  if (Number.isNaN(startedAtTime)) {
    return false;
  }

  const maxRuntimeMs = maxRuntimeHours * 60 * 60 * 1000;
  return now.getTime() - startedAtTime > maxRuntimeMs;
}

export function initializeRuntimeWindowState(
  db: DatabaseAdapter,
  now = new Date(),
): string {
  const startedAt = db.getAgentState(RUNTIME_STARTED_AT_KEY)?.value ?? "";
  const completedAt = db.getAgentState(RUNTIME_COMPLETED_AT_KEY)?.value ?? "";
  const shouldReset =
    !startedAt ||
    (completedAt &&
      new Date(completedAt).getTime() >= new Date(startedAt).getTime());

  if (shouldReset) {
    const value = now.toISOString();
    db.setAgentState(RUNTIME_STARTED_AT_KEY, value);
    db.setAgentState(RUNTIME_COMPLETED_AT_KEY, "");
    return value;
  }

  return startedAt;
}

export function markRuntimeWindowCompleted(
  db: DatabaseAdapter,
  now = new Date(),
): void {
  db.setAgentState(RUNTIME_COMPLETED_AT_KEY, now.toISOString());
}

export function createFounderKey(founder: Founder): string | null {
  const founderName = normalizeText(founder.founderName);
  const companyName = normalizeText(founder.companyName);

  if (founderName && companyName) {
    return `${founderName}|${companyName}`;
  }

  if (companyName) {
    return `${companyName}|${normalizeWebsite(founder.website)}|${founder.source}`;
  }

  return null;
}

export function dedupeFoundersForRun(founders: Founder[]): {
  unique: Founder[];
  duplicatesSkipped: number;
} {
  const seen = new Set<string>();
  const unique: Founder[] = [];
  let duplicatesSkipped = 0;

  for (const founder of founders) {
    const key = createFounderKey(founder);
    if (!key) {
      duplicatesSkipped += 1;
      continue;
    }

    if (seen.has(key)) {
      duplicatesSkipped += 1;
      continue;
    }

    seen.add(key);
    unique.push(founder);
  }

  return { unique, duplicatesSkipped };
}

export function selectFoundersByQuota(
  founders: Founder[],
  quotas: SourceQuotaMap,
  maxFounders: number,
): Founder[] {
  const buckets: Record<ScraperSource, Founder[]> = {
    yc_directory: [],
    hn_launch: [],
    twitter: [],
    producthunt: [],
  };

  for (const founder of founders) {
    buckets[founder.source].push(founder);
  }

  const selected: Founder[] = [];
  const leftovers: Founder[] = [];

  for (const source of SOURCE_PRIORITY) {
    const bucket = buckets[source];
    selected.push(...bucket.slice(0, quotas[source]));
    leftovers.push(...bucket.slice(quotas[source]));
  }

  if (selected.length >= maxFounders) {
    return selected.slice(0, maxFounders);
  }

  for (const founder of leftovers) {
    if (selected.length >= maxFounders) {
      break;
    }
    selected.push(founder);
  }

  return selected;
}

function toTwitterUrl(handle: string | null): string | null {
  if (!handle) {
    return null;
  }

  return `https://twitter.com/${handle.replace(/^@/, "")}`;
}

function cleanValue(value: string | null | undefined): string | null {
  const cleaned = value?.trim() ?? "";
  return cleaned.length > 0 ? cleaned : null;
}

function mergeParsedFounder(
  candidate: RawCandidate,
  parsed: import("./types.js").DeepSeekResponse,
): Founder | null {
  if (!parsed.isFounder) {
    return null;
  }

  const founderName = cleanValue(parsed.founderName) ?? cleanValue(candidate.founderName);
  const companyName = cleanValue(parsed.companyName) ?? cleanValue(candidate.companyName);

  if (!founderName || !companyName) {
    return null;
  }

  const twitterHandle = cleanValue(parsed.twitterHandle) ?? cleanValue(candidate.twitterHandle);
  const website = cleanValue(parsed.website) ?? cleanValue(candidate.website);

  return {
    founderName,
    companyName,
    companyDescription:
      cleanValue(parsed.companyDescription) ??
      cleanValue(candidate.companyDescription),
    linkedinUrl: cleanValue(parsed.linkedinUrl),
    twitterUrl: toTwitterUrl(twitterHandle),
    twitterHandle,
    email: null,
    website,
    ycProfileUrl:
      cleanValue(parsed.ycProfileUrl) ?? cleanValue(candidate.ycProfileUrl),
    batch: cleanValue(parsed.batch) ?? cleanValue(candidate.batch),
    source: candidate.source,
    sentAt: null,
    createdAt: new Date().toISOString(),
  };
}

function buildRawScrapeLimits(quotas: SourceQuotaMap): SourceQuotaMap {
  return {
    yc_directory: Math.max(10, quotas.yc_directory * 2),
    hn_launch: Math.max(10, quotas.hn_launch * 3),
    twitter: Math.max(10, quotas.twitter * 3),
    producthunt: Math.max(10, quotas.producthunt * 3),
  };
}

export interface SchedulerDependencies {
  db: DatabaseAdapter;
  telegram: TelegramService;
  scrapeYcDirectory: typeof scrapeYcDirectory;
  scrapeHnLaunchPosts: typeof scrapeHnLaunchPosts;
  scrapeNitterPosts: typeof scrapeNitterPosts;
  scrapeProductHunt: typeof scrapeProductHunt;
  parseRawCandidate: typeof parseRawCandidate;
  enrichFounderProfile: typeof enrichFounderProfile;
  now: () => Date;
}

export class HermesScheduler {
  private task: ScheduledTask | null = null;
  private isRunning = false;
  private isStopped = false;

  public constructor(private readonly dependencies: SchedulerDependencies) {}

  public async start(): Promise<void> {
    const cronExpression = buildCronExpression(config.RUN_INTERVAL_HOURS);
    logger.info(`Starting scheduler with cron expression ${cronExpression}`);

    this.task = cron.schedule(cronExpression, () => {
      void this.executeRun("scheduled");
    });

    await this.executeRun("startup");
  }

  public async stop(reason = "manual"): Promise<void> {
    if (this.isStopped) {
      return;
    }

    this.isStopped = true;
    this.task?.stop();
    logger.info(`Scheduler stopped (${reason})`);
  }

  private async executeRun(trigger: "startup" | "scheduled"): Promise<void> {
    if (this.isStopped) {
      return;
    }

    if (this.isRunning) {
      logger.warn(`Skipping ${trigger} run because a previous run is still active`);
      return;
    }

    const runtimeStartedAt =
      this.dependencies.db.getAgentState(RUNTIME_STARTED_AT_KEY)?.value ??
      initializeRuntimeWindowState(this.dependencies.db, this.dependencies.now());

    if (hasRuntimeExpired(runtimeStartedAt, config.MAX_RUNTIME_HOURS, this.dependencies.now())) {
      logger.info("Maximum runtime reached; stopping Hermes Agent");
      markRuntimeWindowCompleted(this.dependencies.db, this.dependencies.now());
      await this.stop("max-runtime-reached");
      return;
    }

    this.isRunning = true;
    const runStartedAt = this.dependencies.now().toISOString();
    const runId = this.dependencies.db.createRun(runStartedAt);
    await this.dependencies.telegram.sendRunStartMessage(runId);
    logger.info(`Run #${runId} started at ${runStartedAt}`);

    try {
      await this.retryUnsentFounders(runId);
      await this.processFreshFounders(runId);
    } catch (error) {
      logger.error(
        `Run #${runId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.dependencies.db.incrementRunStat(runId, "errors");
    } finally {
      const stats =
        this.dependencies.db.finishRun(runId) ?? {
          startedAt: runStartedAt,
          foundersFound: 0,
          foundersSent: 0,
          duplicatesSkipped: 0,
          errors: 0,
        };

      await this.dependencies.telegram.sendRunEndMessage(runId, stats);
      logger.info(
        `Run #${runId} finished. Found=${stats.foundersFound}, Sent=${stats.foundersSent}, Duplicates=${stats.duplicatesSkipped}, Errors=${stats.errors}`,
      );

      this.isRunning = false;

      const refreshedRuntimeStartedAt =
        this.dependencies.db.getAgentState(RUNTIME_STARTED_AT_KEY)?.value ??
        runtimeStartedAt;

      if (
        hasRuntimeExpired(
          refreshedRuntimeStartedAt,
          config.MAX_RUNTIME_HOURS,
          this.dependencies.now(),
        )
      ) {
        markRuntimeWindowCompleted(this.dependencies.db, this.dependencies.now());
        await this.stop("max-runtime-reached");
      }
    }
  }

  private async retryUnsentFounders(runId: number): Promise<void> {
    const unsent = this.dependencies.db.getUnsentFounders();

    for (const founder of unsent) {
      const sent = await this.dependencies.telegram.sendFounder(founder);
      if (sent && founder.id) {
        this.dependencies.db.markAsSent(founder.id);
        this.dependencies.db.incrementRunStat(runId, "foundersSent");
      } else if (!sent) {
        this.dependencies.db.incrementRunStat(runId, "errors");
      }
    }
  }

  private async processFreshFounders(runId: number): Promise<void> {
    const quotas = buildSourceQuotas(config.MAX_FOUNDERS_PER_RUN);
    const rawLimits = buildRawScrapeLimits(quotas);
    const visitedUrls = new Set<string>();

    const scrapeResults = await Promise.allSettled([
      this.dependencies.scrapeYcDirectory({
        maxResults: rawLimits.yc_directory,
        visitedUrls,
      }),
      this.dependencies.scrapeHnLaunchPosts({
        maxResults: rawLimits.hn_launch,
        visitedUrls,
      }),
      this.dependencies.scrapeNitterPosts({
        maxResults: rawLimits.twitter,
        visitedUrls,
      }),
      this.dependencies.scrapeProductHunt({
        maxResults: rawLimits.producthunt,
        visitedUrls,
      }),
    ]);

    const ycFounders =
      scrapeResults[0].status === "fulfilled" ? scrapeResults[0].value : [];
    const hnCandidates =
      scrapeResults[1].status === "fulfilled" ? scrapeResults[1].value : [];
    const twitterCandidates =
      scrapeResults[2].status === "fulfilled" ? scrapeResults[2].value : [];
    const productHuntCandidates =
      scrapeResults[3].status === "fulfilled" ? scrapeResults[3].value : [];

    for (const result of scrapeResults) {
      if (result.status === "rejected") {
        this.dependencies.db.incrementRunStat(runId, "errors");
      }
    }

    const parsedFounders: Founder[] = [];
    const rawCandidates = [
      ...hnCandidates,
      ...twitterCandidates,
      ...productHuntCandidates,
    ];

    for (const candidate of rawCandidates) {
      try {
        const parsed = await this.dependencies.parseRawCandidate(candidate);
        if (!parsed) {
          continue;
        }

        const merged = mergeParsedFounder(candidate, parsed);
        if (merged) {
          parsedFounders.push(merged);
        }
      } catch (error) {
        logger.error(
          `Candidate parsing failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.dependencies.db.incrementRunStat(runId, "errors");
      }
    }

    const deduped = dedupeFoundersForRun([...ycFounders, ...parsedFounders]);
    if (deduped.duplicatesSkipped > 0) {
      this.dependencies.db.incrementRunStat(
        runId,
        "duplicatesSkipped",
        deduped.duplicatesSkipped,
      );
    }

    const selected = selectFoundersByQuota(
      deduped.unique,
      quotas,
      config.MAX_FOUNDERS_PER_RUN,
    );

    for (const founder of selected) {
      try {
        const enriched = await this.dependencies.enrichFounderProfile(founder);

        if (
          this.dependencies.db.isDuplicate(
            enriched.founderName,
            enriched.companyName,
          )
        ) {
          this.dependencies.db.incrementRunStat(runId, "duplicatesSkipped");
          continue;
        }

        const inserted = this.dependencies.db.insertFounder({
          ...enriched,
          sentAt: null,
          createdAt: enriched.createdAt || this.dependencies.now().toISOString(),
        });
        this.dependencies.db.incrementRunStat(runId, "foundersFound");

        const sent = await this.dependencies.telegram.sendFounder(inserted);
        if (sent && inserted.id) {
          this.dependencies.db.markAsSent(inserted.id);
          this.dependencies.db.incrementRunStat(runId, "foundersSent");
        } else if (!sent) {
          this.dependencies.db.incrementRunStat(runId, "errors");
        }
      } catch (error) {
        logger.error(
          `Founder processing failed for ${founder.founderName} / ${founder.companyName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.dependencies.db.incrementRunStat(runId, "errors");
      }
    }
  }
}

export function createDefaultScheduler(
  telegram = createTelegramService(),
): HermesScheduler {
  return new HermesScheduler({
    db: database,
    telegram,
    scrapeYcDirectory,
    scrapeHnLaunchPosts,
    scrapeNitterPosts,
    scrapeProductHunt,
    parseRawCandidate,
    enrichFounderProfile,
    now: () => new Date(),
  });
}
