import axios from "axios";
import { load, type CheerioAPI } from "cheerio";

import {
  fetchHtmlWithBrowser,
  launchStealthBrowser,
} from "./browser-utils.js";
import { config } from "./config.js";
import { detectTechCategory, prepareFounderLead } from "./lead-utils.js";
import { logger } from "./logger.js";
import {
  getSourceLabel,
  PUBLIC_PAGE_SOURCES,
  type FounderSourceDefinition,
} from "./sources.js";
import type {
  Founder,
  RawCandidate,
  ScrapeOptions,
  ScraperSource,
} from "./types.js";

const YC_ALGOLIA_URL =
  "https://45BWZJ1SGC-dsn.algolia.net/1/indexes/YCCompany_production/query";
const YC_ALGOLIA_HEADERS = {
  "X-Algolia-Application-Id": "45BWZJ1SGC",
  "X-Algolia-API-Key":
    "NzllNTY5MzJiZGM2OTY2ZTQwMDEzOTNhYWZiZGRjODlhYzVkNjBmOGRjNzJiMWM4ZTU0ZDlhYTZjOTJiMjlhMWFuYWx5dGljc1RhZ3M9eWNkYyZyZXN0cmljdEluZGljZXM9WUNDb21wYW55X3Byb2R1Y3Rpb24lMkNZQ0NvbXBhbnlfQnlfTGF1bmNoX0RhdGVfcHJvZHVjdGlvbiZ0YWdGaWx0ZXJzPSU1QiUyMnljZGNfcHVibGljJTIyJTVE",
};
const YC_ALGOLIA_BODY = {
  filters: 'batch:"Spring 2026" OR batch:"Winter 2026"',
  hitsPerPage: 50,
};

const NITTER_QUERIES = [
  "just got into YC",
  "we are in YC S25",
  "YC W25 batch",
  "accepted into Y Combinator",
  "accepted into Techstars",
  "joining Techstars",
  "joined Techstars",
  "Techstars batch",
  "accepted into Antler",
  "joined Antler Residency",
  "Antler portfolio company",
  "joined Seedcamp",
  "backed by Seedcamp",
  "a16z speedrun",
  "joined a16z speedrun",
  "got into HF0",
  "joined HF0",
  "Neo accelerator",
  "joined Neo Residency",
  "South Park Commons founder fellowship",
  "SPC founder fellowship",
];

const STARTUPWHO_BASE_URL = "https://www.startupwho.com/startups";

export type StartupWhoAcceleratorSource = FounderSourceDefinition & {
  startupWhoSlug?: string;
  slug?: string;
};

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.trim() || message;
}

function toAbsoluteUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function getBatchFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("batch");
  } catch {
    return null;
  }
}

function isExternalWebsite(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ![
      "www.ycombinator.com",
      "ycombinator.com",
      "x.com",
      "twitter.com",
      "www.linkedin.com",
      "linkedin.com",
      "hn.algolia.com",
      "news.ycombinator.com",
      "nitter.poast.org",
      "producthunt.com",
      "www.producthunt.com",
    ].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function isLinkedInProfileUrl(url: string): boolean {
  return /linkedin\.com\/in\//i.test(url);
}

function isTwitterProfileUrl(url: string): boolean {
  return /(twitter|x)\.com\/(?!share|home|search|intent|i\/|hashtag|explore)/i.test(
    url,
  );
}

function firstMatchingUrl(
  urls: Array<string | null | undefined>,
  predicate: (url: string) => boolean,
): string | null {
  return urls.find((url): url is string => Boolean(url && predicate(url))) ?? null;
}

function looksLikePersonName(value: string): boolean {
  const cleaned = cleanText(value);

  if (!cleaned || cleaned.length < 4 || cleaned.length > 60) {
    return false;
  }

  if (/[0-9@/]/.test(cleaned)) {
    return false;
  }

  const words = cleaned.split(" ");
  if (words.length < 2 || words.length > 4) {
    return false;
  }

  if (words.some((word) => /^[A-Z]{2,}$/.test(word))) {
    return false;
  }

  return words.every((word) => /^[A-Z][A-Za-z'’-]+$/.test(word));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function tryParseJsonCandidate(raw: string): unknown | null {
  const trimmed = raw.trim();

  if (!trimmed) {
    return null;
  }

  const candidates = [
    trimmed,
    trimmed.match(/=\s*(\{[\s\S]*\})\s*;?$/)?.[1],
    trimmed.match(/=\s*(\[[\s\S]*\])\s*;?$/)?.[1],
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  return null;
}

function walkNode(
  value: unknown,
  visitor: (node: unknown, parentKey?: string, parentNode?: unknown) => void,
  parentKey?: string,
  parentNode?: unknown,
): void {
  visitor(value, parentKey, parentNode);

  if (Array.isArray(value)) {
    for (const item of value) {
      walkNode(item, visitor, parentKey, value);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walkNode(child, visitor, key, value);
    }
  }
}

function parseJsonScripts(html: string): unknown[] {
  const $ = load(html);
  const payloads: unknown[] = [];

  $("script").each((_index, element) => {
    const content = cleanText($(element).html());
    if (!content) {
      return;
    }

    const parsed = tryParseJsonCandidate(content);
    if (parsed !== null) {
      payloads.push(parsed);
    }
  });

  return payloads;
}

function findFirstStringByKeys(
  payloads: unknown[],
  keys: string[],
): string | null {
  const normalizedKeys = keys.map((key) => key.toLowerCase());
  let found: string | null = null;

  for (const payload of payloads) {
    walkNode(payload, (node, parentKey) => {
      if (found || typeof node !== "string" || !parentKey) {
        return;
      }

      if (normalizedKeys.includes(parentKey.toLowerCase())) {
        const cleaned = cleanText(node);
        if (cleaned) {
          found = cleaned;
        }
      }
    });

    if (found) {
      return found;
    }
  }

  return null;
}

function extractFounderNamesFromJson(payloads: unknown[]): string[] {
  const names: string[] = [];

  for (const payload of payloads) {
    walkNode(payload, (node, parentKey, parentNode) => {
      const inPeopleContext = Boolean(
        parentKey && /(founder|team|member|people)/i.test(parentKey),
      );

      if (!inPeopleContext || !parentNode || typeof parentNode !== "object") {
        return;
      }

      if (typeof node === "string" && looksLikePersonName(node)) {
        names.push(node);
      }
    });
  }

  return uniqueStrings(names);
}

function extractFounderNamesFromText(text: string): string[] {
  const candidates: string[] = [];
  const lines = text
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);

  for (const line of lines) {
    if (looksLikePersonName(line)) {
      candidates.push(line);
      continue;
    }

    if (!/(,|\sand\s)/i.test(line)) {
      continue;
    }

    const matches = line.match(
      /[A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){1,3}/g,
    );

    for (const match of matches ?? []) {
      if (looksLikePersonName(match) && !/founder|company|batch/i.test(match)) {
        candidates.push(match);
      }
    }
  }

  return uniqueStrings(candidates);
}

function extractFounderNamesFromLeadershipText(text: string): string[] {
  const candidates: string[] = [];
  const leadershipMatches = text.matchAll(
    /([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){1,3})\s*(?:,|-|–|\s+)\s*(?:co-?founder|founder|ceo|cto|chief executive|chief technology)/gi,
  );

  for (const match of leadershipMatches) {
    if (match[1] && looksLikePersonName(match[1])) {
      candidates.push(match[1]);
    }
  }

  const foundedByMatch = text.match(/\bfounded by\s+(.+?)(?:\.|,|\n|$)/i);
  if (foundedByMatch?.[1]) {
    candidates.push(...extractFounderNamesFromText(foundedByMatch[1]));
  }

  return uniqueStrings(candidates);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFounderNamesFromYcMetaDescription(
  description: string,
  companyName: string,
): string[] {
  if (!description) {
    return [];
  }

  const companySpecificMatch = description.match(
    new RegExp(
      `\\bFounded in \\d{4} by (.+?),\\s+${escapeRegExp(companyName)}\\s+has\\b`,
      "i",
    ),
  );
  const fallbackMatch = description.match(
    /\bFounded in \d{4} by (.+?)(?:,\s+[^,]+ has\b|$)/i,
  );
  const founderText = cleanText(
    companySpecificMatch?.[1] ?? fallbackMatch?.[1] ?? "",
  );

  return founderText ? extractFounderNamesFromText(founderText) : [];
}

function extractExternalWebsiteFromHtml(html: string, baseUrl: string): string | null {
  const $ = load(html);
  const candidates: string[] = [];

  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }

    const absoluteUrl = toAbsoluteUrl(href, baseUrl);
    if (absoluteUrl && isExternalWebsite(absoluteUrl)) {
      candidates.push(absoluteUrl);
    }
  });

  return uniqueStrings(candidates)[0] ?? null;
}

export interface YcCompanyCard {
  companyName: string;
  companyDescription: string | null;
  ycProfileUrl: string;
  website: string | null;
  batch: string | null;
}

export function extractYcCompanyCardsFromHtml(
  html: string,
  baseUrl: string,
): YcCompanyCard[] {
  const $ = load(html);
  const cards: YcCompanyCard[] = [];
  const seen = new Set<string>();
  const batch = getBatchFromUrl(baseUrl);

  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }

    const absoluteUrl = toAbsoluteUrl(href, baseUrl);
    if (!absoluteUrl) {
      return;
    }

    const parsed = new URL(absoluteUrl);
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    if (
      parsed.hostname !== "www.ycombinator.com" &&
      parsed.hostname !== "ycombinator.com"
    ) {
      return;
    }

    if (pathParts[0] !== "companies" || pathParts.length !== 2) {
      return;
    }

    if (seen.has(absoluteUrl)) {
      return;
    }

    const container = $(element).closest("article, li, div");
    const companyName =
      cleanText($(element).text()) ||
      cleanText(container.find("h2, h3").first().text()) ||
      cleanText(pathParts[1].replace(/-/g, " "));

    if (!companyName) {
      return;
    }

    const descriptionCandidates = [
      cleanText(container.find("p").first().text()),
      cleanText(container.find("span").eq(1).text()),
    ].filter(Boolean);

    const website =
      container
        .find("a[href]")
        .toArray()
        .map((node) => $(node).attr("href"))
        .map((candidate) => (candidate ? toAbsoluteUrl(candidate, baseUrl) : null))
        .find((candidate) => Boolean(candidate && isExternalWebsite(candidate))) ??
      null;

    cards.push({
      companyName,
      companyDescription: descriptionCandidates[0] ?? null,
      ycProfileUrl: absoluteUrl,
      website,
      batch,
    });
    seen.add(absoluteUrl);
  });

  return cards;
}

export function extractYcFounderDetailsFromHtml(
  html: string,
  detailUrl: string,
  batch: string | null,
  fallback: Pick<YcCompanyCard, "companyName" | "companyDescription" | "website">,
): Founder[] {
  const $ = load(html);
  const payloads = parseJsonScripts(html);
  const metaDescription = cleanText($('meta[name="description"]').attr("content"));
  const companyName =
    fallback.companyName ||
    cleanText($("h1").first().text()) ||
    findFirstStringByKeys(payloads, ["companyName", "name"]) ||
    "Unknown Company";
  const companyDescription =
    fallback.companyDescription ||
    findFirstStringByKeys(payloads, ["oneLiner", "tagline", "description"]) ||
    metaDescription ||
    cleanText($("p").first().text()) ||
    null;
  const website =
    fallback.website ||
    findFirstStringByKeys(payloads, ["website", "websiteUrl"]) ||
    extractExternalWebsiteFromHtml(html, detailUrl);

  const structuredFounderNames = uniqueStrings([
    ...extractFounderNamesFromJson(payloads),
    ...extractFounderNamesFromYcMetaDescription(metaDescription, companyName),
  ]);
  const founderNames =
    structuredFounderNames.length > 0
      ? structuredFounderNames
      : extractFounderNamesFromText($.root().text());

  return founderNames.map((founderName) => ({
    founderName,
    companyName,
    companyDescription,
    linkedinUrl: null,
    twitterUrl: null,
    twitterHandle: null,
    email: null,
    website,
    ycProfileUrl: detailUrl,
    sourceProfileUrl: detailUrl,
    fundingSource: "Y Combinator",
    fundingDate: null,
    fundingRound: batch,
    techCategory: detectTechCategory(companyDescription),
    careersUrl: null,
    engineeringHiringSignal: false,
    batch,
    source: "yc_directory",
    sentAt: null,
    createdAt: new Date().toISOString(),
  }));
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(record: UnknownRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const cleaned = cleanText(value);
      if (cleaned) {
        return cleaned;
      }
    }
  }

  return null;
}

function normalizeApiUrl(value: string | null, baseUrl?: string): string | null {
  const cleaned = cleanText(value);

  if (!cleaned) {
    return null;
  }

  if (/^https?:\/\//i.test(cleaned)) {
    return cleaned;
  }

  if (cleaned.startsWith("/") && baseUrl) {
    return toAbsoluteUrl(cleaned, baseUrl);
  }

  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(cleaned)) {
    return `https://${cleaned}`;
  }

  return null;
}

function extractYcAlgoliaHits(payload: unknown): UnknownRecord[] {
  if (!isRecord(payload) || !Array.isArray(payload.hits)) {
    return [];
  }

  return payload.hits.filter(isRecord);
}

function extractYcFounderNames(value: unknown): string[] {
  const names: string[] = [];

  if (typeof value === "string") {
    names.push(...extractFounderNamesFromText(value));
  } else if (Array.isArray(value)) {
    for (const founder of value) {
      if (typeof founder === "string") {
        names.push(cleanText(founder));
        continue;
      }

      if (!isRecord(founder)) {
        continue;
      }

      const fullName = stringField(founder, [
        "name",
        "full_name",
        "fullName",
        "founder_name",
        "founderName",
      ]);
      if (fullName) {
        names.push(fullName);
        continue;
      }

      const firstName = stringField(founder, ["first_name", "firstName"]);
      const lastName = stringField(founder, ["last_name", "lastName"]);
      if (firstName && lastName) {
        names.push(`${firstName} ${lastName}`);
      }
    }
  }

  return uniqueStrings(names);
}

function buildYcCompanyDescription(
  oneLiner: string | null,
  longDescription: string | null,
): string | null {
  if (oneLiner && longDescription && oneLiner !== longDescription) {
    return `${oneLiner}\n\n${longDescription}`;
  }

  return oneLiner ?? longDescription;
}

function buildYcProfileUrl(hit: UnknownRecord): string | null {
  const directUrl = normalizeApiUrl(
    stringField(hit, ["url", "yc_url", "ycUrl"]),
    "https://www.ycombinator.com",
  );

  if (directUrl) {
    return directUrl;
  }

  const slug = stringField(hit, ["slug"]);
  return slug ? `https://www.ycombinator.com/companies/${slug}` : null;
}

export function extractYcCompaniesFromAlgoliaPayload(
  payload: unknown,
): YcCompanyCard[] {
  const companies: YcCompanyCard[] = [];

  for (const hit of extractYcAlgoliaHits(payload)) {
    const companyName = stringField(hit, ["name"]);
    const ycProfileUrl = buildYcProfileUrl(hit);

    if (!companyName || !ycProfileUrl) {
      continue;
    }

    const oneLiner = stringField(hit, ["one_liner", "oneLiner"]);
    const longDescription = stringField(hit, [
      "long_description",
      "longDescription",
    ]);

    companies.push({
      companyName,
      companyDescription: buildYcCompanyDescription(oneLiner, longDescription),
      ycProfileUrl,
      website: normalizeApiUrl(stringField(hit, ["website"])),
      batch: stringField(hit, ["batch"]),
    });
  }

  return companies;
}

export function extractYcFoundersFromAlgoliaPayload(payload: unknown): Founder[] {
  const founders: Founder[] = [];

  for (const hit of extractYcAlgoliaHits(payload)) {
    const companyName = stringField(hit, ["name"]);
    if (!companyName) {
      continue;
    }

    const oneLiner = stringField(hit, ["one_liner", "oneLiner"]);
    const longDescription = stringField(hit, [
      "long_description",
      "longDescription",
    ]);
    const companyDescription = buildYcCompanyDescription(
      oneLiner,
      longDescription,
    );
    const website = normalizeApiUrl(stringField(hit, ["website"]));
    const ycProfileUrl = buildYcProfileUrl(hit);
    const batch = stringField(hit, ["batch"]);
    const founderNames = extractYcFounderNames(hit.founders);

    for (const founderName of founderNames) {
      founders.push({
        founderName,
        companyName,
        companyDescription,
        linkedinUrl: null,
        twitterUrl: null,
        twitterHandle: null,
        email: null,
        website,
        ycProfileUrl,
        sourceProfileUrl: ycProfileUrl,
        fundingSource: "Y Combinator",
        fundingDate: null,
        fundingRound: batch,
        techCategory: detectTechCategory(companyDescription),
        careersUrl: null,
        engineeringHiringSignal: false,
        batch,
        source: "yc_directory",
        sentAt: null,
        createdAt: new Date().toISOString(),
      });
    }
  }

  return founders;
}

async function fetchYcCompanyFoundersFromDetailPage(
  company: YcCompanyCard,
): Promise<Founder[]> {
  try {
    const response = await axios.get<string>(company.ycProfileUrl, {
      timeout: 20_000,
      headers: {
        Accept: "text/html",
      },
    });

    return extractYcFounderDetailsFromHtml(
      response.data,
      company.ycProfileUrl,
      company.batch,
      company,
    );
  } catch (error) {
    logger.warn(
      `YC company detail fetch failed for ${company.ycProfileUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

interface HnHit {
  title?: string | null;
  url?: string | null;
  author?: string | null;
  story_text?: string | null;
  created_at?: string | null;
}

export function filterHnLaunchHits(
  hits: HnHit[],
  maxResults = Number.POSITIVE_INFINITY,
): RawCandidate[] {
  return hits
    .filter((hit) => cleanText(hit.title).startsWith("Launch HN:"))
    .slice(0, maxResults)
    .map((hit) => {
      const title = cleanText(hit.title);
      const companyName = cleanText(
        title.replace(/^Launch HN:\s*/i, "").split("|")[0]?.split("(")[0] ?? "",
      );
      return {
        source: "hn_launch",
        rawText: [title, hit.story_text, hit.url, hit.author].filter(Boolean).join("\n"),
        founderName: null,
        companyName: companyName || null,
        companyDescription: null,
        website: hit.url ?? null,
        ycProfileUrl: null,
        sourceProfileUrl: hit.url ?? null,
        fundingSource: "Launch HN",
        fundingDate: hit.created_at ?? null,
        fundingRound: "Launch",
        techCategory: detectTechCategory([title, hit.story_text].filter(Boolean).join("\n")),
        careersUrl: null,
        engineeringHiringSignal: false,
        twitterHandle: null,
        batch: null,
      } satisfies RawCandidate;
    });
}

function normalizeTwitterHandle(value: string | null | undefined): string | null {
  const cleaned = cleanText(value).replace(/^@/, "");
  return cleaned || null;
}

export function extractNitterCandidatesFromHtml(
  html: string,
  query: string,
): RawCandidate[] {
  const $ = load(html);
  const results: RawCandidate[] = [];

  $(".timeline-item, article").each((_index, element) => {
    const container = $(element);
    const tweetText = cleanText(
      container.find(".tweet-content, .main-tweet p, p").first().text(),
    );
    const handle = normalizeTwitterHandle(
      container.find(".username, .username a").first().text(),
    );
    const displayName = cleanText(
      container.find(".fullname, .display-name, .name").first().text(),
    );

    if (!tweetText) {
      return;
    }

    results.push({
      source: "twitter",
      rawText: [`Query: ${query}`, displayName, handle ? `@${handle}` : null, tweetText]
        .filter(Boolean)
        .join("\n"),
      founderName: looksLikePersonName(displayName) ? displayName : null,
      companyName: null,
      companyDescription: null,
      website: null,
      ycProfileUrl: null,
      sourceProfileUrl: null,
      fundingSource: "Twitter",
      fundingDate: new Date().toISOString(),
      fundingRound: null,
      techCategory: detectTechCategory(tweetText),
      careersUrl: null,
      engineeringHiringSignal: false,
      twitterHandle: handle,
      batch: null,
    });
  });

  return results;
}

function isWithinThisWeekLabel(
  label: string,
  referenceDate = new Date(),
): boolean {
  const normalized = cleanText(label).toLowerCase();

  if (!normalized) {
    return true;
  }

  if (normalized.includes("today") || normalized.includes("yesterday")) {
    return true;
  }

  const relativeDays = normalized.match(/(\d+)\s*d/);
  if (relativeDays) {
    return Number(relativeDays[1]) <= 7;
  }

  const daysMatch = normalized.match(/(\d+)\s+day/);
  if (daysMatch) {
    return Number(daysMatch[1]) <= 7;
  }

  const parsedDate = new Date(label);
  if (Number.isNaN(parsedDate.getTime())) {
    return true;
  }

  const diffMs = referenceDate.getTime() - parsedDate.getTime();
  return diffMs >= 0 && diffMs <= 7 * 24 * 60 * 60 * 1000;
}

export function extractProductHuntCandidatesFromHtml(
  html: string,
  referenceDate = new Date(),
): RawCandidate[] {
  const $ = load(html);
  const results: RawCandidate[] = [];

  $("article, section div").each((_index, element) => {
    const container = $(element);
    const productAnchor =
      container.find('a[href*="/posts/"]').first().attr("href") ?? null;
    const productName = cleanText(
      container.find('a[href*="/posts/"]').first().text() ||
        container.find("h3, h2").first().text(),
    );

    if (!productAnchor || !productName) {
      return;
    }

    const makerAnchor =
      container.find('a[href^="/@"], a[href*="/makers/"]').first().attr("href") ??
      null;
    const makerName = cleanText(
      container.find('a[href^="/@"], a[href*="/makers/"]').first().text(),
    );
    const dateLabel = cleanText(
      container.find("time").attr("datetime") ||
        container.find("time").text() ||
        container.find('[class*="date"]').first().text(),
    );

    if (!isWithinThisWeekLabel(dateLabel, referenceDate)) {
      return;
    }

    const makerProfileUrl = makerAnchor
      ? toAbsoluteUrl(makerAnchor, "https://www.producthunt.com")
      : null;
    const productUrl = toAbsoluteUrl(productAnchor, "https://www.producthunt.com");
    const tagline = cleanText(container.find("p").first().text());

    results.push({
      source: "producthunt",
      rawText: [
        `Product: ${productName}`,
        makerName ? `Maker: ${makerName}` : null,
        tagline ? `Tagline: ${tagline}` : null,
        makerProfileUrl ? `Maker Profile: ${makerProfileUrl}` : null,
        productUrl ? `Product URL: ${productUrl}` : null,
        dateLabel ? `Posted: ${dateLabel}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      founderName: looksLikePersonName(makerName) ? makerName : null,
      companyName: productName,
      companyDescription: tagline || null,
      website: productUrl,
      ycProfileUrl: null,
      sourceProfileUrl: productUrl,
      fundingSource: "Product Hunt",
      fundingDate: referenceDate.toISOString(),
      fundingRound: "Launch",
      techCategory: detectTechCategory(`${productName}\n${tagline}`),
      careersUrl: null,
      engineeringHiringSignal: false,
      twitterHandle: null,
      batch: null,
    });
  });

  return results;
}

function buildStartupWhoUrl(slug: string, page = 1): string {
  const url = new URL(STARTUPWHO_BASE_URL);
  url.searchParams.set("source", slug);

  if (page > 1) {
    url.searchParams.set("page", String(page));
  }

  return url.toString();
}

function getStartupWhoSlug(source: StartupWhoAcceleratorSource): string {
  return source.startupWhoSlug ?? source.slug ?? source.source;
}

function buildAcceleratorDescription(
  accelerator: StartupWhoAcceleratorSource,
  industry: string | null,
  location: string | null,
): string | null {
  const parts = [
    `Accelerator: ${accelerator.label}`,
    industry ? `Industry: ${industry}` : null,
    location ? `Location: ${location}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join("\n") : null;
}

export function extractStartupWhoAcceleratorFoundersFromHtml(
  html: string,
  accelerator: StartupWhoAcceleratorSource,
): Founder[] {
  const $ = load(html);
  const founders: Founder[] = [];
  const seen = new Set<string>();

  $("tbody tr").each((_index, element) => {
    const cells = $(element).find("td");
    if (cells.length < 4) {
      return;
    }

    const companyName =
      cleanText(cells.eq(0).find(".font-medium").first().text()) ||
      cleanText(cells.eq(0).find("span").first().text());
    const industry = cleanText(cells.eq(1).text()) || null;
    const location = cleanText(cells.eq(2).text()) || null;
    const founderText = cleanText(cells.eq(3).text()).replace(/^[—-]+$/, "");
    const website =
      normalizeApiUrl(cells.eq(4).find("a[href]").first().attr("href") ?? null) ??
      null;
    const rowUrls = cells
      .find("a[href]")
      .toArray()
      .map((node) => normalizeApiUrl($(node).attr("href") ?? null))
      .filter((url): url is string => Boolean(url));
    const sourceProfileUrl =
      rowUrls.find((url) => url.includes("startupwho.com")) ??
      buildStartupWhoUrl(getStartupWhoSlug(accelerator));
    const linkedinUrl = firstMatchingUrl(rowUrls, isLinkedInProfileUrl);
    const twitterUrl = firstMatchingUrl(rowUrls, isTwitterProfileUrl);
    const fundingDate = cleanText(cells.eq(5).text()) || null;

    if (!companyName || !founderText) {
      return;
    }

    const companyDescription = buildAcceleratorDescription(
      accelerator,
      industry,
      location,
    );

    for (const founderName of extractFounderNamesFromText(founderText)) {
      const key = `${accelerator.source}|${companyName}|${founderName}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      founders.push({
        founderName,
        companyName,
        companyDescription,
        linkedinUrl,
        twitterUrl,
        twitterHandle: null,
        email: null,
        website,
        sourceProfileUrl,
        fundingSource: accelerator.label,
        fundingDate,
        fundingRound: "StartupWho listing",
        techCategory: detectTechCategory(companyDescription),
        careersUrl: null,
        engineeringHiringSignal: false,
        ycProfileUrl: null,
        batch: null,
        source: accelerator.source,
        sentAt: null,
        createdAt: new Date().toISOString(),
      });
    }
  });

  return founders;
}

function extractPublishedDateFromHtml(html: string): string | null {
  const $ = load(html);
  const candidates = [
    $('meta[property="article:published_time"]').attr("content"),
    $('meta[name="date"]').attr("content"),
    $("time[datetime]").first().attr("datetime"),
    $("time").first().text(),
  ];

  for (const candidate of candidates) {
    const cleaned = cleanText(candidate);
    if (!cleaned) {
      continue;
    }

    const parsed = new Date(cleaned);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
}

function extractBatchOrRound(text: string): string | null {
  const batch = text.match(/\b(Spring|Summer|Fall|Autumn|Winter)\s+2026\b/i)?.[0];
  if (batch) {
    return batch;
  }

  const shorthand = text.match(/\b[SWF]26\b/i)?.[0];
  if (shorthand) {
    return shorthand.toUpperCase();
  }

  const round = text.match(
    /\b(pre-seed|seed|series\s+[a-c]|accelerator|cohort|arc|inception|speedrun)\b/i,
  )?.[0];
  return round ?? null;
}

type CheerioSelectable = Parameters<CheerioAPI>[0];

function collectOfficialContainers($: CheerioAPI): CheerioSelectable[] {
  const selectors = [
    "article",
    "li",
    '[class*="card"]',
    '[class*="company"]',
    '[class*="portfolio"]',
    '[class*="startup"]',
    '[class*="cohort"]',
  ].join(",");

  const containers = $(selectors)
    .toArray()
    .filter((element) => {
      const text = cleanText($(element).text());
      return text.length >= 20 && text.length <= 2_500;
    }) as CheerioSelectable[];

  if (containers.length > 0) {
    return containers;
  }

  return $("section, main > div, body > div")
    .toArray()
    .filter((element) => {
      const text = cleanText($(element).text());
      return text.length >= 20 && text.length <= 2_500;
    }) as CheerioSelectable[];
}

export function extractOfficialPortfolioFoundersFromHtml(
  html: string,
  source: FounderSourceDefinition,
  pageUrl: string,
): Founder[] {
  const $ = load(html);
  const founders: Founder[] = [];
  const seen = new Set<string>();
  const pageFundingDate = extractPublishedDateFromHtml(html);
  const pageText = cleanText($.root().text());

  for (const element of collectOfficialContainers($)) {
    const container = $(element);
    const text = cleanText(container.text());
    const companyName =
      cleanText(container.find("h1, h2, h3, h4").first().text()) ||
      cleanText(container.find("a[href]").first().text());

    if (!companyName || looksLikePersonName(companyName)) {
      continue;
    }

    const description =
      cleanText(container.find("p").first().text()) ||
      text.slice(0, 500) ||
      null;
    const urls = container
      .find("a[href]")
      .toArray()
      .map((node) => toAbsoluteUrl($(node).attr("href") ?? "", pageUrl))
      .filter((url): url is string => Boolean(url));
    const website =
      urls.find((url) => isExternalWebsite(url) && !isLinkedInProfileUrl(url) && !isTwitterProfileUrl(url)) ??
      null;
    const sourceProfileUrl =
      urls.find((url) => {
        try {
          const parsed = new URL(url);
          const pageHost = new URL(pageUrl).hostname;
          return parsed.hostname === pageHost && parsed.toString() !== pageUrl;
        } catch {
          return false;
        }
      }) ?? pageUrl;
    const linkedinUrl = firstMatchingUrl(urls, isLinkedInProfileUrl);
    const twitterUrl = firstMatchingUrl(urls, isTwitterProfileUrl);
    const founderNames = extractFounderNamesFromLeadershipText(text);
    const fundingRound = extractBatchOrRound(text) ?? extractBatchOrRound(pageText);
    const techCategory = detectTechCategory(`${description ?? ""}\n${text}`);

    for (const founderName of founderNames) {
      const key = `${source.source}|${companyName}|${founderName}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      founders.push(
        prepareFounderLead({
          founderName,
          companyName,
          companyDescription: description,
          linkedinUrl,
          twitterUrl,
          twitterHandle: null,
          email: null,
          website,
          ycProfileUrl: null,
          sourceProfileUrl,
          fundingSource: source.label,
          fundingDate: pageFundingDate,
          fundingRound,
          techCategory,
          careersUrl: null,
          engineeringHiringSignal: false,
          batch: fundingRound,
          source: source.source,
          sentAt: null,
          createdAt: new Date().toISOString(),
        }),
      );
    }
  }

  return founders;
}

export async function scrapeYcDirectory(
  options: ScrapeOptions = {},
): Promise<Founder[]> {
  const maxFounders = options.maxResults ?? 20;

  try {
    const response = await axios.post<unknown>(
      YC_ALGOLIA_URL,
      YC_ALGOLIA_BODY,
      {
        headers: YC_ALGOLIA_HEADERS,
        timeout: 20_000,
      },
    );
    const founders = extractYcFoundersFromAlgoliaPayload(response.data).slice(
      0,
      maxFounders,
    );

    if (founders.length > 0) {
      logger.info(`YC directory scrape complete with ${founders.length} founders`);
      return founders;
    }

    for (const company of extractYcCompaniesFromAlgoliaPayload(response.data)) {
      if (founders.length >= maxFounders) {
        break;
      }

      founders.push(...(await fetchYcCompanyFoundersFromDetailPage(company)));
    }

    logger.info(`YC directory scrape complete with ${founders.length} founders`);
    return founders.slice(0, maxFounders);
  } catch (error) {
    logger.error(
      `YC directory scrape failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return [];
  }
}

export async function scrapeHnLaunchPosts(
  options: ScrapeOptions = {},
): Promise<RawCandidate[]> {
  try {
    const response = await axios.get<{
      hits?: HnHit[];
    }>("https://hn.algolia.com/api/v1/search?query=Launch+HN&tags=story&hitsPerPage=50", {
      timeout: 20_000,
    });

    const hits = response.data.hits ?? [];
    const results = filterHnLaunchHits(hits, options.maxResults ?? 20);
    logger.info(`Launch HN scrape complete with ${results.length} candidates`);
    return results;
  } catch (error) {
    logger.error(
      `Launch HN scrape failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

export async function scrapeStartupWhoAccelerators(
  options: ScrapeOptions = {},
): Promise<Founder[]> {
  const maxFounders = options.maxResults ?? 20;
  const publicSources = PUBLIC_PAGE_SOURCES;
  const perSourceLimit = Math.max(
    2,
    Math.ceil(maxFounders / publicSources.length),
  );
  const founders: Founder[] = [];

  for (const accelerator of publicSources) {
    if (founders.length >= maxFounders) {
      break;
    }

    const sourceStartCount = founders.length;

    if (accelerator.startupWhoSlug) {
      try {
        const response = await axios.get<string>(
          buildStartupWhoUrl(accelerator.startupWhoSlug),
          {
            timeout: 20_000,
            headers: {
              Accept: "text/html",
            },
          },
        );

        founders.push(
          ...extractStartupWhoAcceleratorFoundersFromHtml(
            response.data,
            accelerator as StartupWhoAcceleratorSource,
          ).slice(0, perSourceLimit),
        );
      } catch (error) {
        logger.warn(
          `StartupWho ${accelerator.label} scrape failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (founders.length >= maxFounders || !accelerator.officialUrls?.length) {
      continue;
    }

    for (const officialUrl of accelerator.officialUrls) {
      if (founders.length >= maxFounders) {
        break;
      }

      try {
        const response = await axios.get<string>(officialUrl, {
          timeout: 20_000,
          headers: {
            Accept: "text/html",
          },
        });

        founders.push(
          ...extractOfficialPortfolioFoundersFromHtml(
            response.data,
            accelerator,
            officialUrl,
          ).slice(0, perSourceLimit),
        );
      } catch (error) {
        logger.warn(
          `Official ${accelerator.label} scrape failed for ${officialUrl}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    logger.info(
      `Public source ${accelerator.label} returned ${
        founders.length - sourceStartCount
      } founders`,
    );
  }

  const sliced = founders.slice(0, maxFounders);
  logger.info(
    `Public founder source scrape complete with ${sliced.length} founders`,
  );
  return sliced;
}

export async function scrapeNitterPosts(
  options: ScrapeOptions = {},
): Promise<RawCandidate[]> {
  const visitedUrls = options.visitedUrls ?? new Set<string>();
  const maxResults = options.maxResults ?? 20;
  const browser = await launchStealthBrowser();

  try {
    const results: RawCandidate[] = [];
    const seen = new Set<string>();

    for (const baseUrl of config.NITTER_BASE_URLS) {
      let hostResponded = false;

      for (const query of NITTER_QUERIES) {
        const searchUrl = `${baseUrl}/search?f=tweets&q=${encodeURIComponent(
          query,
        )}`;

        try {
          const page = await fetchHtmlWithBrowser(browser, searchUrl, {
            visitedUrls,
          });

          if (!page) {
            continue;
          }

          hostResponded = true;

          for (const candidate of extractNitterCandidatesFromHtml(
            page.html,
            query,
          )) {
            const key = `${candidate.twitterHandle ?? "unknown"}|${candidate.rawText}`;
            if (!seen.has(key)) {
              seen.add(key);
              results.push(candidate);
            }
          }
        } catch (error) {
          logger.warn(
            `Nitter query failed on ${baseUrl} for "${query}": ${summarizeError(
              error,
            )}`,
          );
          break;
        }

        if (results.length >= maxResults) {
          break;
        }
      }

      if (hostResponded || results.length >= maxResults) {
        break;
      }
    }

    const sliced = results.slice(0, maxResults);
    logger.info(`Nitter scrape complete with ${sliced.length} candidates`);
    return sliced;
  } catch (error) {
    logger.error(
      `Nitter scrape failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  } finally {
    await browser.close();
  }
}

export async function scrapeProductHunt(
  options: ScrapeOptions = {},
): Promise<RawCandidate[]> {
  const visitedUrls = options.visitedUrls ?? new Set<string>();
  const browser = await launchStealthBrowser();

  try {
    const page = await fetchHtmlWithBrowser(browser, "https://www.producthunt.com", {
      visitedUrls,
    });

    if (!page) {
      return [];
    }

    const results = extractProductHuntCandidatesFromHtml(page.html).slice(
      0,
      options.maxResults ?? 20,
    );
    logger.info(`Product Hunt scrape complete with ${results.length} candidates`);
    return results;
  } catch (error) {
    logger.error(
      `Product Hunt scrape failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  } finally {
    await browser.close();
  }
}
