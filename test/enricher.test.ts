import assert from "node:assert/strict";
import test from "node:test";

import { clearCachedConfig } from "../src/config.js";
import {
  buildTwitterUrlFromHandle,
  enrichFounderProfile,
  extractResultUrlsFromGoogleHtml,
  findCareersSignal,
} from "../src/enricher.js";

function configureEnv(): void {
  process.env.DEEPSEEK_API_KEY = "deepseek-key";
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_CHAT_ID = "12345";
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

test("enrichFounderProfile fills in LinkedIn and X without email lookup", async () => {
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

        return '<a href="/url?q=https%3A%2F%2Fx.com%2Falicej&sa=U">X</a>';
      },
    },
    careers: {
      fetchUrl: async () => null,
    },
  });

  assert.equal(enriched.linkedinUrl, "https://www.linkedin.com/in/alice-johnson");
  assert.equal(enriched.twitterUrl, buildTwitterUrlFromHandle("alicej"));
  assert.equal(enriched.email, null);
  assert.equal(enriched.website, "https://atlasai.com/");
});

test("findCareersSignal detects engineering roles from common careers pages", async () => {
  const visited: string[] = [];
  const signal = await findCareersSignal("https://atlasai.com", {
    fetchUrl: async (url) => {
      visited.push(url);
      if (url.endsWith("/careers")) {
        return `
          <html>
            <body>
              <h1>Careers</h1>
              <a>Founding Full-Stack Engineer</a>
              <a>Backend Developer</a>
            </body>
          </html>
        `;
      }

      return null;
    },
  });

  assert.equal(signal.careersUrl, "https://atlasai.com/careers");
  assert.equal(signal.engineeringHiringSignal, true);
  assert.deepEqual(visited, ["https://atlasai.com/careers"]);
});
