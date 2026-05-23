import type { Browser, BrowserContext } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const FALLBACK_USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

let stealthInitialized = false;

function getRandomIntInclusive(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function randomDelay(
  minMs = 2000,
  maxMs = 5000,
): Promise<void> {
  await sleep(getRandomIntInclusive(minMs, maxMs));
}

function normalizeVisitedUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function markVisited(visitedUrls: Set<string>, url: string): boolean {
  const normalized = normalizeVisitedUrl(url);
  if (visitedUrls.has(normalized)) {
    return false;
  }

  visitedUrls.add(normalized);
  return true;
}

type FakeHeadersModule = {
  default?: unknown;
  headers?: () => Record<string, string>;
  generate?: () => Record<string, string>;
  Headers?: new (...args: unknown[]) => {
    generate?: () => Record<string, string>;
  };
};

function resolveHeadersObject(candidate: unknown): Record<string, string> | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  return candidate as Record<string, string>;
}

function chooseFallbackUserAgent(): string {
  return FALLBACK_USER_AGENTS[
    getRandomIntInclusive(0, FALLBACK_USER_AGENTS.length - 1)
  ];
}

export async function getRandomUserAgent(): Promise<string> {
  try {
    const loaded = (await import("fake-headers")) as FakeHeadersModule;
    const moduleValue = loaded.default ?? loaded;

    const generators: Array<() => Record<string, string> | null> = [];

    if (typeof loaded.headers === "function") {
      generators.push(() => loaded.headers?.() ?? null);
    }

    if (typeof loaded.generate === "function") {
      generators.push(() => loaded.generate?.() ?? null);
    }

    if (typeof moduleValue === "function") {
      generators.push(() => resolveHeadersObject((moduleValue as () => unknown)()));
    }

    if (loaded.Headers) {
      const HeadersConstructor = loaded.Headers;
      generators.push(() => new HeadersConstructor().generate?.() ?? null);
    }

    for (const generator of generators) {
      const headers = generator();
      const userAgent =
        headers?.["User-Agent"] ??
        headers?.["user-agent"] ??
        headers?.userAgent;

      if (userAgent) {
        return userAgent;
      }
    }
  } catch {
    return chooseFallbackUserAgent();
  }

  return chooseFallbackUserAgent();
}

async function applyContextHardening(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });

    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });

    Object.defineProperty(navigator, "platform", {
      get: () => "MacIntel",
    });
  });
}

export async function launchStealthBrowser(): Promise<Browser> {
  if (!stealthInitialized) {
    chromium.use(StealthPlugin());
    stealthInitialized = true;
  }

  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  }) as unknown as Promise<Browser>;
}

export async function createStealthContext(
  browser: Browser,
): Promise<BrowserContext> {
  const userAgent = await getRandomUserAgent();
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
  });

  await applyContextHardening(context);
  return context;
}

export interface FetchHtmlResult {
  html: string;
  finalUrl: string;
}

type WaitUntilState = "load" | "domcontentloaded" | "networkidle" | "commit";

export async function fetchHtmlWithBrowser(
  browser: Browser,
  url: string,
  options?: {
    visitedUrls?: Set<string>;
    waitUntil?: WaitUntilState;
    timeoutMs?: number;
  },
): Promise<FetchHtmlResult | null> {
  if (options?.visitedUrls && !markVisited(options.visitedUrls, url)) {
    return null;
  }

  await randomDelay();

  const context = await createStealthContext(browser);
  try {
    const page = await context.newPage();
    await page.goto(url, {
      waitUntil: options?.waitUntil ?? "domcontentloaded",
      timeout: options?.timeoutMs ?? 45_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(
      () => undefined,
    );

    return {
      html: await page.content(),
      finalUrl: page.url(),
    };
  } finally {
    await context.close();
  }
}
