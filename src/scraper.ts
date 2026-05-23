import axios from "axios";
import { load } from "cheerio";

import {
  fetchHtmlWithBrowser,
  launchStealthBrowser,
} from "./browser-utils.js";
import { logger } from "./logger.js";
import type { Founder, RawCandidate, ScrapeOptions } from "./types.js";

const YC_BATCH_URLS = [
  "https://www.ycombinator.com/companies?batch=S25",
  "https://www.ycombinator.com/companies?batch=W25",
  "https://www.ycombinator.com/companies?batch=S26",
  "https://www.ycombinator.com/companies?batch=W26",
];

const NITTER_BASE_URL = "https://nitter.poast.org";
const NITTER_QUERIES = [
  "just got into YC",
  "we are in YC S25",
  "YC W25 batch",
  "accepted into Y Combinator",
];

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
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
  const companyName =
    fallback.companyName ||
    cleanText($("h1").first().text()) ||
    findFirstStringByKeys(payloads, ["companyName", "name"]) ||
    "Unknown Company";
  const companyDescription =
    fallback.companyDescription ||
    findFirstStringByKeys(payloads, ["oneLiner", "tagline", "description"]) ||
    cleanText($('meta[name="description"]').attr("content")) ||
    cleanText($("p").first().text()) ||
    null;
  const website =
    fallback.website ||
    findFirstStringByKeys(payloads, ["website", "websiteUrl"]) ||
    extractExternalWebsiteFromHtml(html, detailUrl);

  const founderNames = uniqueStrings([
    ...extractFounderNamesFromJson(payloads),
    ...extractFounderNamesFromText($.root().text()),
  ]);

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
    batch,
    source: "yc_directory",
    sentAt: null,
    createdAt: new Date().toISOString(),
  }));
}

interface HnHit {
  title?: string | null;
  url?: string | null;
  author?: string | null;
  story_text?: string | null;
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
      twitterHandle: null,
      batch: null,
    });
  });

  return results;
}

export async function scrapeYcDirectory(
  options: ScrapeOptions = {},
): Promise<Founder[]> {
  const visitedUrls = options.visitedUrls ?? new Set<string>();
  const maxFounders = options.maxResults ?? 20;
  const maxCompanyPages = Math.max(8, Math.ceil(maxFounders / 2));
  const founders: Founder[] = [];
  const browser = await launchStealthBrowser();

  try {
    for (const batchUrl of YC_BATCH_URLS) {
      const listingPage = await fetchHtmlWithBrowser(browser, batchUrl, {
        visitedUrls,
      });

      if (!listingPage) {
        continue;
      }

      const cards = extractYcCompanyCardsFromHtml(listingPage.html, batchUrl).slice(
        0,
        maxCompanyPages,
      );

      for (const card of cards) {
        if (founders.length >= maxFounders) {
          break;
        }

        const detailPage = await fetchHtmlWithBrowser(browser, card.ycProfileUrl, {
          visitedUrls,
        });

        if (!detailPage) {
          continue;
        }

        founders.push(
          ...extractYcFounderDetailsFromHtml(
            detailPage.html,
            card.ycProfileUrl,
            card.batch,
            card,
          ),
        );
      }
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
  } finally {
    await browser.close();
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

export async function scrapeNitterPosts(
  options: ScrapeOptions = {},
): Promise<RawCandidate[]> {
  const visitedUrls = options.visitedUrls ?? new Set<string>();
  const browser = await launchStealthBrowser();

  try {
    const results: RawCandidate[] = [];
    const seen = new Set<string>();

    for (const query of NITTER_QUERIES) {
      const searchUrl = `${NITTER_BASE_URL}/search?f=tweets&q=${encodeURIComponent(
        query,
      )}`;
      const page = await fetchHtmlWithBrowser(browser, searchUrl, {
        visitedUrls,
      });

      if (!page) {
        continue;
      }

      for (const candidate of extractNitterCandidatesFromHtml(page.html, query)) {
        const key = `${candidate.twitterHandle ?? "unknown"}|${candidate.rawText}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(candidate);
        }
      }
    }

    const sliced = results.slice(0, options.maxResults ?? 20);
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
