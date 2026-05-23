import assert from "node:assert/strict";
import test from "node:test";
import { AxiosError } from "axios";

import { clearCachedConfig } from "../src/config.js";
import {
  buildTwitterUrlFromHandle,
  enrichFounderProfile,
  extractResultUrlsFromGoogleHtml,
  findEmailWithHunter,
} from "../src/enricher.js";

function configureEnv(): void {
  process.env.DEEPSEEK_API_KEY = "deepseek-key";
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_CHAT_ID = "12345";
  process.env.HUNTER_API_KEY = "hunter-key";
  clearCachedConfig();
}

test("extractResultUrlsFromGoogleHtml returns decoded target URLs", () => {
  const html = `
    <a href="/url?q=https%3A%2F%2Fwww.linkedin.com%2Fin%2Falice-johnson&sa=U">LinkedIn</a>
    <a href="/url?q=https%3A%2F%2Ftwitter.com%2Falicej&sa=U">Twitter</a>
  `;

  assert.deepEqual(extractResultUrlsFromGoogleHtml(html), [
    "https://www.linkedin.com/in/alice-johnson",
    "https://twitter.com/alicej",
  ]);
});

test("findEmailWithHunter returns null on quota exhaustion", async () => {
  configureEnv();
  const quotaError = new AxiosError(
    "quota exceeded",
    undefined,
    undefined,
    undefined,
    {
      status: 429,
      statusText: "Too Many Requests",
      headers: {},
      config: {} as never,
      data: "quota exceeded",
    },
  );

  const email = await findEmailWithHunter("Alice Johnson", "https://atlasai.com", {
    httpClient: {
      get: async () => {
        throw quotaError;
      },
    },
  });

  assert.equal(email, null);
});

test("enrichFounderProfile fills in LinkedIn, Twitter, and email", async () => {
  configureEnv();
  const founder = {
    founderName: "Alice Johnson",
    companyName: "Atlas AI",
    companyDescription: "AI operating system",
    linkedinUrl: null,
    twitterUrl: null,
    twitterHandle: "alicej",
    email: null,
    website: "atlasai.com",
    ycProfileUrl: null,
    batch: "S25",
    source: "yc_directory" as const,
    sentAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const enriched = await enrichFounderProfile(founder, {
    search: {
      fetchSearchHtml: async (query) => {
        if (query.includes("linkedin.com/in")) {
          return '<a href="/url?q=https%3A%2F%2Fwww.linkedin.com%2Fin%2Falice-johnson&sa=U">LinkedIn</a>';
        }

        return '<a href="/url?q=https%3A%2F%2Ftwitter.com%2Falicej&sa=U">Twitter</a>';
      },
    },
    httpClient: {
      get: async () =>
        ({
          data: {
            data: {
              email: "alice@atlasai.com",
            },
          },
        }) as never,
    },
  });

  assert.equal(enriched.linkedinUrl, "https://www.linkedin.com/in/alice-johnson");
  assert.equal(enriched.twitterUrl, buildTwitterUrlFromHandle("alicej"));
  assert.equal(enriched.email, "alice@atlasai.com");
  assert.equal(enriched.website, "https://atlasai.com/");
});
