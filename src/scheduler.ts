import cron, { type ScheduledTask } from "node-cron";

import { config } from "./config.js";
import type { DatabaseAdapter } from "./database.js";
import { database } from "./database.js";
import { enrichFounderProfile } from "./enricher.js";
import {
  isLikelyTechCandidate,
  prepareFounderLead,
  getFounderLeadRejectionReasons,
  shouldConsiderFounderForLead,
  shouldSendFounderLead,
  sortFounderLeads,
} from "./lead-utils.js";
import { logger } from "./logger.js";
import { ApiSpendLimitReachedError, parseRawCandidate } from "./parser.js";
import {
  scrapeHnLaunchPosts,
  scrapeNitterPosts,
  scrapeProductHunt,
  scrapeStartupWhoAccelerators,
  scrapeYcDirectory,
} from "./scraper.js";
import { ALL_SOURCES, getSourceLabel, PUBLIC_PAGE_SOURCES } from "./sources.js";
import { createTelegramService, type TelegramService } from "./telegram.js";
import type {
  Founder,
  RawCandidate,
  ScraperSource,
  SourceQuotaMap,
} from "./types.js";

const SOURCE_PRIORITY: ScraperSource[] = ALL_SOURCES;

const SOURCE_WEIGHTS: Record<ScraperSource, number> = {
  yc_directory: 0.16,
  techstars: 0.08,
  antler: 0.06,
  a16z: 0.05,
  "500global": 0.05,
  general_catalyst: 0.05,
  greylock: 0.05,
  accel: 0.05,
  index_ventures: 0.04,
  lightspeed: 0.04,
  hn_launch: 0.06,
  twitter: 0.04,
  producthunt: 0.04,
  sequoia_arc: 0.03,
  google_for_startups: 0.03,
  microsoft_for_startups: 0.03,
  nvidia_inception: 0.03,
  founders_fund: 0.03,
  pear_vc: 0.03,
  hax: 0.03,
  plug_and_play: 0.02,
  entrepreneur_first: 0.02,
  alchemist: 0.02,
  neo: 0.02,
  benchmark: 0.02,
  on_deck: 0.01,
  seedcamp: 0.01,
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
  const base = Object.fromEntries(
    SOURCE_PRIORITY.map((source) => [
      source,
      Math.floor(maxFounders * SOURCE_WEIGHTS[source]),
    ]),
  ) as SourceQuotaMap;

  let allocated = Object.values(base).reduce((sum, value) => sum + value, 0);

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
  const buckets = Object.fromEntries(
    SOURCE_PRIORITY.map((source) => [source, [] as Founder[]]),
  ) as Record<ScraperSource, Founder[]>;

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

  return `https://x.com/${handle.replace(/^@/, "")}`;
}

function cleanValue(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
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
    sourceProfileUrl:
      cleanValue(parsed.sourceProfileUrl) ??
      cleanValue(candidate.sourceProfileUrl) ??
      cleanValue(parsed.ycProfileUrl) ??
      cleanValue(candidate.ycProfileUrl) ??
      website,
    fundingSource: cleanValue(candidate.fundingSource),
    fundingDate: cleanValue(candidate.fundingDate),
    fundingRound: cleanValue(candidate.fundingRound),
    techCategory: cleanValue(candidate.techCategory),
    careersUrl: cleanValue(candidate.careersUrl),
    engineeringHiringSignal: Boolean(candidate.engineeringHiringSignal),
    batch: cleanValue(parsed.batch) ?? cleanValue(candidate.batch),
    source: candidate.source,
    sentAt: null,
    createdAt: new Date().toISOString(),
  };
}

function founderToRawCandidate(founder: Founder): RawCandidate {
  return {
    source: founder.source,
    rawText: [
      `Source: ${founder.source}`,
      `Founder: ${founder.founderName}`,
      `Company: ${founder.companyName}`,
      founder.companyDescription
        ? `Description: ${founder.companyDescription}`
        : null,
      founder.linkedinUrl ? `LinkedIn: ${founder.linkedinUrl}` : null,
      founder.twitterHandle ? `Twitter Handle: ${founder.twitterHandle}` : null,
      founder.twitterUrl ? `Twitter: ${founder.twitterUrl}` : null,
      founder.website ? `Website: ${founder.website}` : null,
      founder.ycProfileUrl ? `YC Profile: ${founder.ycProfileUrl}` : null,
      founder.batch ? `Batch: ${founder.batch}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    founderName: founder.founderName,
    companyName: founder.companyName,
    companyDescription: founder.companyDescription,
    website: founder.website,
    ycProfileUrl: founder.ycProfileUrl,
    sourceProfileUrl:
      founder.sourceProfileUrl ?? founder.ycProfileUrl ?? founder.website,
    fundingSource: founder.fundingSource,
    fundingDate: founder.fundingDate,
    fundingRound: founder.fundingRound,
    techCategory: founder.techCategory,
    careersUrl: founder.careersUrl,
    engineeringHiringSignal: founder.engineeringHiringSignal,
    twitterHandle: founder.twitterHandle,
    batch: founder.batch,
  };
}

function buildRawScrapeLimits(quotas: SourceQuotaMap): SourceQuotaMap {
  return Object.fromEntries(
    SOURCE_PRIORITY.map((source) => [
      source,
      Math.max(
        10,
        quotas[source] *
          (["hn_launch", "twitter", "producthunt"].includes(source) ? 3 : 2),
      ),
    ]),
  ) as SourceQuotaMap;
}

function sumQuotasForSources(
  quotas: SourceQuotaMap,
  sources: ScraperSource[],
): number {
  return sources.reduce((sum, source) => sum + quotas[source], 0);
}

function formatFounderCountsBySource(founders: Founder[]): string {
  const counts = new Map<ScraperSource, number>();

  for (const founder of founders) {
    counts.set(founder.source, (counts.get(founder.source) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => SOURCE_PRIORITY.indexOf(left) - SOURCE_PRIORITY.indexOf(right))
    .map(([source, count]) => `${getSourceLabel(source)}=${count}`)
    .join(", ");
}

export interface SchedulerDependencies {
  db: DatabaseAdapter;
  telegram: TelegramService;
  scrapeYcDirectory: typeof scrapeYcDirectory;
  scrapeHnLaunchPosts: typeof scrapeHnLaunchPosts;
  scrapeNitterPosts: typeof scrapeNitterPosts;
  scrapeProductHunt: typeof scrapeProductHunt;
  scrapeStartupWhoAccelerators: typeof scrapeStartupWhoAccelerators;
  parseRawCandidate: typeof parseRawCandidate;
  enrichFounderProfile: typeof enrichFounderProfile;
  now: () => Date;
  exitProcess?: (code: number) => never | void;
}

export class HermesScheduler {
  private task: ScheduledTask | null = null;
  private isRunning = false;
  private isStopped = false;

  public constructor(private readonly dependencies: SchedulerDependencies) {}

  public async start(): Promise<void> {
    if (config.DRY_RUN) {
      logger.info("DRY_RUN=true; executing one dry run without cron scheduler");
      await this.executeDryRun();
      return;
    }

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

  private isApiSpendLimitReached(): boolean {
    return this.dependencies.db.getTotalSpend() >= config.MAX_API_SPEND_USD;
  }

  private exitProcess(code: number): void {
    const exitProcess =
      this.dependencies.exitProcess ??
      ((exitCode: number): never => process.exit(exitCode));
    exitProcess(code);
  }

  private async stopForApiSpendLimitReached(): Promise<void> {
    const totalFounders = this.dependencies.db.getTotalFoundersFound();

    console.log("🛑 Spend limit reached — shutting down");
    await this.dependencies.telegram.sendSpendLimitReachedMessage(
      config.MAX_API_SPEND_USD,
      totalFounders,
    );
    await this.stop("api-spend-limit-reached");
    this.dependencies.db.closeDb();
    this.exitProcess(0);
  }

  private async executeDryRun(): Promise<void> {
    if (this.isApiSpendLimitReached()) {
      await this.stopForApiSpendLimitReached();
      return;
    }

    this.isRunning = true;
    const runStartedAt = this.dependencies.now().toISOString();
    const runId = this.dependencies.db.createRun(runStartedAt);
    let exitCode = 0;
    let handledSpendLimit = false;

    console.log("🧪 Dry run mode enabled — cron scheduler will not start");
    console.log("🧪 Dry run: scraping sources (max 3 founders)");

    try {
      const visitedUrls = new Set<string>();
      const scrapedFounders = (
        await this.dependencies.scrapeYcDirectory({
          maxResults: 3,
          visitedUrls,
          dryRun: true,
        })
      ).slice(0, 3);

      console.log(
        `🧪 Dry run: YC directory returned ${scrapedFounders.length} founders`,
      );

      const parsedFounders: Founder[] = scrapedFounders
        .map(prepareFounderLead)
        .filter(shouldConsiderFounderForLead);

      if (scrapedFounders.length > 0) {
        console.log(
          `🧪 Dry run: kept ${parsedFounders.length}/${scrapedFounders.length} YC founders after deterministic tech/recency filters`,
        );
      }

      if (parsedFounders.length === 0) {
        const warning =
          "Dry run: YC directory produced 0 usable leads; trying public founder sources";
        logger.warn(warning);
        console.warn(`⚠️ ${warning}`);

        console.log("🧪 Dry run: scraping public founder sources (max 3 founders)");

        const acceleratorFounders = (
          await this.dependencies.scrapeStartupWhoAccelerators({
            maxResults: 3,
            visitedUrls,
            dryRun: true,
          })
        ).slice(0, 3);

        console.log(
          `🧪 Dry run: public founder sources returned ${acceleratorFounders.length} founders`,
        );

        parsedFounders.push(
          ...acceleratorFounders
            .map(prepareFounderLead)
            .filter(shouldConsiderFounderForLead),
        );

        const fallbackSources = [
          {
            label: "Launch HN",
            scrape: this.dependencies.scrapeHnLaunchPosts,
          },
          {
            label: "Nitter",
            scrape: this.dependencies.scrapeNitterPosts,
          },
          {
            label: "Product Hunt",
            scrape: this.dependencies.scrapeProductHunt,
          },
        ];

        const shouldTryPaidDryRunFallback =
          parsedFounders.length === 0 && config.DRY_RUN_USE_LLM;
        if (!config.DRY_RUN_USE_LLM && parsedFounders.length === 0) {
          console.log(
            "🧪 Dry run: skipping raw social/news parsing because DRY_RUN_USE_LLM=false",
          );
        }

        for (const source of shouldTryPaidDryRunFallback ? fallbackSources : []) {
          console.log(`🧪 Dry run: scraping ${source.label} (max 3 candidates)`);

          let rawCandidates: RawCandidate[] = [];
          try {
            rawCandidates = (
              await source.scrape({
                maxResults: 3,
                visitedUrls,
              })
            ).slice(0, 3);
          } catch (error) {
            if (error instanceof ApiSpendLimitReachedError) {
              throw error;
            }

            const message = `Dry run: ${source.label} scrape failed; trying next source: ${
              error instanceof Error ? error.message : String(error)
            }`;
            logger.warn(message);
            console.warn(`⚠️ ${message}`);
            continue;
          }

          console.log(
            `🧪 Dry run: ${source.label} returned ${rawCandidates.length} candidates`,
          );

          if (rawCandidates.length === 0) {
            const message = `Dry run: ${source.label} returned 0 candidates; trying next source`;
            logger.warn(message);
            console.warn(`⚠️ ${message}`);
            continue;
          }

          const candidatesToParse = rawCandidates
            .filter(isLikelyTechCandidate)
            .slice(0, Math.min(3, config.LLM_PARSE_MAX_PER_RUN));

          for (const [index, candidate] of candidatesToParse.entries()) {
            console.log(
              `🧠 Dry run: parsing ${source.label} candidate ${index + 1}/${candidatesToParse.length} with DeepSeek`,
            );

            try {
              const parsed =
                await this.dependencies.parseRawCandidate(candidate);
              const merged = parsed
                ? mergeParsedFounder(candidate, parsed)
                : null;

              if (merged) {
                parsedFounders.push(merged);
              }
            } catch (error) {
              if (error instanceof ApiSpendLimitReachedError) {
                throw error;
              }

              const message = `Dry run: parsing ${source.label} candidate failed: ${
                error instanceof Error ? error.message : String(error)
              }`;
              logger.warn(message);
              console.warn(`⚠️ ${message}`);
            }
          }

          if (parsedFounders.length > 0) {
            break;
          }

          const message = `Dry run: ${source.label} produced 0 founders; trying next source`;
          logger.warn(message);
          console.warn(`⚠️ ${message}`);
        }
      }

      if (parsedFounders.length === 0) {
        throw new Error("Dry run found 0 founders across all sources");
      }

      const enrichedFounders: Founder[] = [];

      for (const [index, founder] of parsedFounders.entries()) {
        console.log(
          `🔎 Dry run: enriching founder ${index + 1}/${parsedFounders.length} — ${founder.founderName} / ${founder.companyName}`,
        );

        const enriched = prepareFounderLead(
          await this.dependencies.enrichFounderProfile(founder),
        );

        if (!shouldSendFounderLead(enriched)) {
          const reasons = getFounderLeadRejectionReasons(enriched).join(", ");
          logger.info(
            `Dry run: skipping ${enriched.founderName} / ${enriched.companyName}: ${
              reasons || "lead requirements were not met"
            }`,
          );
          continue;
        }

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
        enrichedFounders.push(inserted);
      }

      const founderToSend = enrichedFounders[0];
      if (!founderToSend) {
        throw new Error(
          "Dry run could not send Telegram message because no founders were found",
        );
      }

      console.log(
        `📨 Dry run: sending exactly 1 founder message to Telegram — ${founderToSend.founderName} / ${founderToSend.companyName}`,
      );

      const sent = await this.dependencies.telegram.sendFounder(founderToSend);
      if (!sent) {
        this.dependencies.db.incrementRunStat(runId, "errors");
        throw new Error("Dry run Telegram founder message failed");
      }

      if (founderToSend.id) {
        this.dependencies.db.markAsSent(founderToSend.id);
      }
      this.dependencies.db.incrementRunStat(runId, "foundersSent");

      const totalSpend = this.dependencies.db.getTotalSpend();
      console.log(
        `✅ Dry run complete — ${enrichedFounders.length} founders found, $${totalSpend.toFixed(4)} spent, Telegram working`,
      );
    } catch (error) {
      if (error instanceof ApiSpendLimitReachedError) {
        handledSpendLimit = true;
        this.dependencies.db.finishRun(runId);
        this.isRunning = false;
        await this.stopForApiSpendLimitReached();
        return;
      }

      exitCode = 1;
      const message = error instanceof Error ? error.message : String(error);
      this.dependencies.db.incrementRunStat(runId, "errors");
      logger.error(`Dry run failed: ${message}`);
      console.error(`❌ Dry run failed: ${message}`);
    } finally {
      if (!handledSpendLimit) {
        this.dependencies.db.finishRun(runId);
        this.isRunning = false;
        this.dependencies.db.closeDb();
        this.exitProcess(exitCode);
      }
    }
  }

  private async executeRun(trigger: "startup" | "scheduled"): Promise<void> {
    if (this.isStopped) {
      return;
    }

    if (this.isRunning) {
      logger.warn(`Skipping ${trigger} run because a previous run is still active`);
      return;
    }

    if (this.isApiSpendLimitReached()) {
      logger.info("API spend limit reached before run start; stopping Hermes Agent");
      await this.stopForApiSpendLimitReached();
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

    let shouldStopForApiSpendLimit = false;

    try {
      await this.retryUnsentFounders(runId);
      await this.processFreshFounders(runId);
    } catch (error) {
      if (error instanceof ApiSpendLimitReachedError) {
        shouldStopForApiSpendLimit = true;
        logger.info(
          `API spend limit reached during run #${runId}: $${error.totalSpend.toFixed(4)} / $${error.limit.toFixed(2)}`,
        );
      } else {
        logger.error(
          `Run #${runId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.dependencies.db.incrementRunStat(runId, "errors");
      }
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

      if (shouldStopForApiSpendLimit || this.isApiSpendLimitReached()) {
        await this.stopForApiSpendLimitReached();
        return;
      }

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
      this.dependencies.scrapeStartupWhoAccelerators({
        maxResults: sumQuotasForSources(
          rawLimits,
          PUBLIC_PAGE_SOURCES.map((source) => source.source),
        ),
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
    const acceleratorFounders =
      scrapeResults[1].status === "fulfilled" ? scrapeResults[1].value : [];
    const hnCandidates =
      scrapeResults[2].status === "fulfilled" ? scrapeResults[2].value : [];
    const twitterCandidates =
      scrapeResults[3].status === "fulfilled" ? scrapeResults[3].value : [];
    const productHuntCandidates =
      scrapeResults[4].status === "fulfilled" ? scrapeResults[4].value : [];

    for (const result of scrapeResults) {
      if (result.status === "rejected") {
        this.dependencies.db.incrementRunStat(runId, "errors");
      }
    }

    const parsedFounders: Founder[] = [];
    const structuredFounders = [
      ...ycFounders.map(prepareFounderLead),
      ...acceleratorFounders.map(prepareFounderLead),
    ];
    logger.info(
      `Structured candidates by source before filters: ${
        formatFounderCountsBySource(structuredFounders) || "none"
      }`,
    );

    const rawCandidates = [
      ...hnCandidates,
      ...twitterCandidates,
      ...productHuntCandidates,
    ]
      .filter(isLikelyTechCandidate)
      .slice(0, config.LLM_PARSE_MAX_PER_RUN);

    if (config.LLM_PARSE_MAX_PER_RUN === 0) {
      logger.info("Skipping raw social/news LLM parsing because LLM_PARSE_MAX_PER_RUN=0");
    } else {
      logger.info(
        `Raw candidates selected for LLM parsing after tech filter: ${rawCandidates.length}`,
      );
    }

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
        if (error instanceof ApiSpendLimitReachedError) {
          throw error;
        }

        logger.error(
          `Candidate parsing failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.dependencies.db.incrementRunStat(runId, "errors");
      }
    }

    const consideredFounders = [
      ...structuredFounders.filter(shouldConsiderFounderForLead),
      ...parsedFounders.map(prepareFounderLead).filter(shouldConsiderFounderForLead),
    ];
    logger.info(
      `Lead candidates by source after tech/recency filters: ${
        formatFounderCountsBySource(consideredFounders) || "none"
      }`,
    );

    const deduped = dedupeFoundersForRun(consideredFounders);
    if (deduped.duplicatesSkipped > 0) {
      this.dependencies.db.incrementRunStat(
        runId,
        "duplicatesSkipped",
        deduped.duplicatesSkipped,
      );
    }

    const selected = sortFounderLeads(selectFoundersByQuota(
      deduped.unique,
      quotas,
      config.MAX_FOUNDERS_PER_RUN,
    ));

    for (const founder of selected) {
      try {
        const enriched = prepareFounderLead(
          await this.dependencies.enrichFounderProfile(founder),
        );

        if (!shouldSendFounderLead(enriched)) {
          const reasons = getFounderLeadRejectionReasons(enriched).join(", ");
          logger.info(
            `Skipping ${enriched.founderName} / ${enriched.companyName}: ${
              reasons || "lead requirements were not met"
            }`,
          );
          continue;
        }

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
    scrapeStartupWhoAccelerators,
    parseRawCandidate,
    enrichFounderProfile,
    now: () => new Date(),
  });
}
