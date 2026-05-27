import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { clearCachedConfig } from "../src/config.js";
import { closeDb, getTotalSpend, initDb } from "../src/database.js";
import {
  extractJsonObjectFromResponse,
  parseFounderData,
} from "../src/parser.js";

function createTempDbPath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "hermes-parser-"));
  return path.join(directory, "hermes.sqlite");
}

function configureEnv(): void {
  process.env.DEEPSEEK_API_KEY = "deepseek-key";
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_CHAT_ID = "12345";
  process.env.DRY_RUN = "false";
  process.env.MAX_API_SPEND_USD = "2.00";
  clearCachedConfig();
}

test("extractJsonObjectFromResponse parses raw JSON payloads", () => {
  const parsed = extractJsonObjectFromResponse(`
    {"founderName":"Alice Johnson","companyName":"Atlas AI","companyDescription":null,"linkedinUrl":null,"twitterHandle":"alicej","website":"https://atlasai.com","ycProfileUrl":null,"batch":"S25","isFounder":true}
  `);

  assert.equal(parsed?.founderName, "Alice Johnson");
  assert.equal(parsed?.isFounder, true);
});

test("parseFounderData retries once after a transient API failure", async () => {
  configureEnv();
  closeDb();
  initDb(createTempDbPath());

  let attempts = 0;
  const sleepCalls: number[] = [];

  const client = {
    chat: {
      completions: {
        create: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("temporary failure");
          }

          return {
            choices: [
              {
                message: {
                  content:
                    '{"founderName":"Maya Chen","companyName":"LedgerLeaf","companyDescription":"Accounting workflows","linkedinUrl":null,"twitterHandle":"mayachen","website":"https://ledgerleaf.ai","ycProfileUrl":null,"batch":"S25","isFounder":true}',
                },
              },
            ],
            usage: {
              prompt_tokens: 1_000,
              completion_tokens: 500,
            },
          };
        },
      },
    },
  };

  const parsed = await parseFounderData("raw founder text", {
    client,
    sleepFn: async (ms) => {
      sleepCalls.push(ms);
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(sleepCalls, [3000]);
  assert.equal(parsed?.companyName, "LedgerLeaf");
  assert.ok(Math.abs(getTotalSpend() - 0.00062) < Number.EPSILON);

  closeDb();
});

test("parseFounderData retries once after invalid JSON output", async () => {
  configureEnv();
  closeDb();
  initDb(createTempDbPath());

  let attempts = 0;
  const sleepCalls: number[] = [];

  const client = {
    chat: {
      completions: {
        create: async () => {
          attempts += 1;

          return {
            choices: [
              {
                message: {
                  content:
                    attempts === 1
                      ? "I found a founder but cannot format this cleanly."
                      : '{"founderName":"Maya Chen","companyName":"LedgerLeaf","companyDescription":"Accounting workflows","linkedinUrl":null,"twitterHandle":"mayachen","website":"https://ledgerleaf.ai","ycProfileUrl":null,"batch":"S25","isFounder":true}',
                },
              },
            ],
            usage: {
              prompt_tokens: 1_000,
              completion_tokens: 500,
            },
          };
        },
      },
    },
  };

  const parsed = await parseFounderData("raw founder text", {
    client,
    sleepFn: async (ms) => {
      sleepCalls.push(ms);
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(sleepCalls, [1000]);
  assert.equal(parsed?.companyName, "LedgerLeaf");

  closeDb();
});
