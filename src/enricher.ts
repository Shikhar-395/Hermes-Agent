import axios, { AxiosError } from "axios";
import type { Browser } from "playwright";

import {
  fetchHtmlWithBrowser,
  launchStealthBrowser,
} from "./browser-utils.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { EnrichedProfile, Founder } from "./types.js";

export interface SearchDependencies {
  browser?: Browser;
  fetchSearchHtml?: (query: string) => Promise<string | null>;
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

export function extractDomainFromWebsite(value: string | null): string | null {
  const website = normalizeWebsiteUrl(value);
  if (!website) {
    return null;
  }

  try {
    return new URL(website).hostname.replace(/^www\./, "");
  } catch {
    return null;
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
  return normalized ? `https://twitter.com/${normalized}` : null;
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
    `${founderName} ${companyName} site:twitter.com`,
    (url) => /twitter\.com\/(?!share|home|search)/i.test(url),
    dependencies,
  );
}

export async function findEmailWithHunter(
  founderName: string,
  website: string | null,
  options?: {
    httpClient?: Pick<typeof axios, "get">;
  },
): Promise<string | null> {
  const httpClient = options?.httpClient ?? axios;
  const domain = extractDomainFromWebsite(website);

  if (!domain) {
    return null;
  }

  const parts = founderName.trim().split(/\s+/);
  const firstName = parts[0] ?? "";
  const lastName = parts.slice(1).join(" ");

  try {
    const response = await httpClient.get<{
      data?: {
        email?: string | null;
      };
    }>("https://api.hunter.io/v2/email-finder", {
      params: {
        domain,
        first_name: firstName,
        last_name: lastName,
        api_key: config.HUNTER_API_KEY,
      },
      timeout: 20_000,
    });

    return response.data.data?.email ?? null;
  } catch (error) {
    if (
      error instanceof AxiosError &&
      (error.response?.status === 429 ||
        `${error.response?.data ?? ""}`.includes("quota"))
    ) {
      logger.warn(`Hunter quota hit for domain ${domain}`);
      return null;
    }

    logger.error(
      `Hunter email lookup failed for ${founderName} at ${domain}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export async function enrichFounderProfile(
  founder: Founder,
  dependencies?: {
    search?: SearchDependencies;
    httpClient?: Pick<typeof axios, "get">;
  },
): Promise<EnrichedProfile> {
  const website = normalizeWebsiteUrl(founder.website) ?? founder.website;
  const twitterUrlFromHandle = founder.twitterUrl ?? buildTwitterUrlFromHandle(founder.twitterHandle);

  const [linkedinUrl, discoveredTwitterUrl, email] = await Promise.all([
    founder.linkedinUrl
      ? Promise.resolve(founder.linkedinUrl)
      : findLinkedInUrl(founder.founderName, founder.companyName, dependencies?.search),
    twitterUrlFromHandle
      ? Promise.resolve(twitterUrlFromHandle)
      : findTwitterUrl(founder.founderName, founder.companyName, dependencies?.search),
    founder.email
      ? Promise.resolve(founder.email)
      : findEmailWithHunter(founder.founderName, website, {
          httpClient: dependencies?.httpClient,
        }),
  ]);

  return {
    ...founder,
    website,
    linkedinUrl,
    twitterUrl: discoveredTwitterUrl,
    email,
  };
}
