import axios from "axios";
import type { Browser } from "playwright";

import {
  fetchHtmlWithBrowser,
  launchStealthBrowser,
} from "./browser-utils.js";
import { hasEngineeringHiringSignal } from "./lead-utils.js";
import { logger } from "./logger.js";
import type { EnrichedProfile, Founder } from "./types.js";

export interface SearchDependencies {
  browser?: Browser;
  fetchSearchHtml?: (query: string) => Promise<string | null>;
}

export interface CareersDependencies {
  fetchUrl?: (url: string) => Promise<string | null>;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeWebsiteUrl(value: string | null): string | null {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return null;
  }

  try {
    return new URL(cleaned).toString();
  } catch {
    try {
      return new URL(`https://${cleaned}`).toString();
    } catch {
      return null;
    }
  }
}

export function normalizeTwitterHandle(
  handle: string | null | undefined,
): string | null {
  const normalized = cleanText(handle).replace(/^@/, "");
  return normalized || null;
}

export function buildTwitterUrlFromHandle(
  handle: string | null | undefined,
): string | null {
  const normalized = normalizeTwitterHandle(handle);
  return normalized ? `https://x.com/${normalized}` : null;
}

export function extractResultUrlsFromGoogleHtml(html: string): string[] {
  const matches = [...html.matchAll(/href="([^"]+)"/g)];
  const urls: string[] = [];

  for (const match of matches) {
    const href = match[1];
    if (!href) {
      continue;
    }

    if (href.startsWith("/url?q=")) {
      const parsed = new URL(`https://www.google.com${href}`);
      const target = parsed.searchParams.get("q");
      if (target) {
        urls.push(decodeURIComponent(target));
      }
      continue;
    }

    if (href.startsWith("http")) {
      urls.push(href);
    }
  }

  return [...new Set(urls)];
}

async function fetchGoogleSearchHtml(query: string, browser?: Browser): Promise<string | null> {
  const ownedBrowser = browser ?? (await launchStealthBrowser());

  try {
    const page = await fetchHtmlWithBrowser(
      ownedBrowser,
      `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`,
      {
        timeoutMs: 30_000,
      },
    );

    return page?.html ?? null;
  } finally {
    if (!browser) {
      await ownedBrowser.close();
    }
  }
}

async function searchGoogleProfile(
  query: string,
  validator: (url: string) => boolean,
  dependencies?: SearchDependencies,
): Promise<string | null> {
  try {
    const html =
      (await dependencies?.fetchSearchHtml?.(query)) ??
      (await fetchGoogleSearchHtml(query, dependencies?.browser));

    if (!html) {
      return null;
    }

    return extractResultUrlsFromGoogleHtml(html).find(validator) ?? null;
  } catch (error) {
    logger.error(
      `Google search failed for "${query}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export async function findLinkedInUrl(
  founderName: string,
  companyName: string,
  dependencies?: SearchDependencies,
): Promise<string | null> {
  return searchGoogleProfile(
    `${founderName} ${companyName} site:linkedin.com/in`,
    (url) => /linkedin\.com\/in\//i.test(url),
    dependencies,
  );
}

export async function findTwitterUrl(
  founderName: string,
  companyName: string,
  dependencies?: SearchDependencies,
): Promise<string | null> {
  return searchGoogleProfile(
    `${founderName} ${companyName} (site:x.com OR site:twitter.com)`,
    (url) => /(twitter|x)\.com\/(?!share|home|search|intent|i\/)/i.test(url),
    dependencies,
  );
}

async function fetchUrlHtml(url: string): Promise<string | null> {
  try {
    const response = await axios.get<string>(url, {
      timeout: 8_000,
      headers: {
        Accept: "text/html",
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });

    return typeof response.data === "string" ? response.data : null;
  } catch {
    return null;
  }
}

function buildCareersCandidates(website: string | null): string[] {
  const normalized = normalizeWebsiteUrl(website);
  if (!normalized) {
    return [];
  }

  const parsed = new URL(normalized);
  const origin = parsed.origin;
  return [
    `${origin}/careers`,
    `${origin}/jobs`,
    `${origin}/join-us`,
    `${origin}/join`,
    `${origin}/about`,
  ];
}

export async function findCareersSignal(
  website: string | null,
  dependencies?: CareersDependencies,
): Promise<{
  careersUrl: string | null;
  engineeringHiringSignal: boolean;
}> {
  const fetcher = dependencies?.fetchUrl ?? fetchUrlHtml;

  for (const url of buildCareersCandidates(website)) {
    const html = await fetcher(url);
    if (!html) {
      continue;
    }

    const text = cleanText(html.replace(/<[^>]+>/g, " "));
    const looksLikeCareersPage = /\b(careers|jobs|open roles|join us|hiring)\b/i.test(
      `${url} ${text}`,
    );
    const engineeringHiringSignal = hasEngineeringHiringSignal(text);

    if (looksLikeCareersPage || engineeringHiringSignal) {
      return {
        careersUrl: url,
        engineeringHiringSignal,
      };
    }
  }

  return {
    careersUrl: null,
    engineeringHiringSignal: false,
  };
}

export async function enrichFounderProfile(
  founder: Founder,
  dependencies?: {
    search?: SearchDependencies;
    careers?: CareersDependencies;
  },
): Promise<EnrichedProfile> {
  const website = normalizeWebsiteUrl(founder.website) ?? founder.website;
  const twitterUrlFromHandle = founder.twitterUrl ?? buildTwitterUrlFromHandle(founder.twitterHandle);

  const [linkedinUrl, discoveredTwitterUrl, careersSignal] = await Promise.all([
    founder.linkedinUrl
      ? Promise.resolve(founder.linkedinUrl)
      : findLinkedInUrl(founder.founderName, founder.companyName, dependencies?.search),
    twitterUrlFromHandle
      ? Promise.resolve(twitterUrlFromHandle)
      : findTwitterUrl(founder.founderName, founder.companyName, dependencies?.search),
    founder.careersUrl
      ? Promise.resolve({
          careersUrl: founder.careersUrl,
          engineeringHiringSignal: Boolean(founder.engineeringHiringSignal),
        })
      : findCareersSignal(website, dependencies?.careers),
  ]);

  return {
    ...founder,
    website,
    linkedinUrl,
    twitterUrl: discoveredTwitterUrl,
    careersUrl: careersSignal.careersUrl,
    engineeringHiringSignal: careersSignal.engineeringHiringSignal,
    email: founder.email,
  };
}
