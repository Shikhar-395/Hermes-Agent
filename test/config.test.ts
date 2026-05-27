import assert from "node:assert/strict";
import test from "node:test";

import { clearCachedConfig, loadConfig } from "../src/config.js";

const REQUIRED_ENV = {
  DEEPSEEK_API_KEY: "deepseek-key",
  TELEGRAM_BOT_TOKEN: "telegram-token",
  TELEGRAM_CHAT_ID: "12345",
};

function withEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    ...REQUIRED_ENV,
    ...overrides,
  };
}

test("loadConfig parses defaults and positive integers", () => {
  clearCachedConfig();
  const parsed = loadConfig(withEnv());

  assert.equal(parsed.MAX_FOUNDERS_PER_RUN, 50);
  assert.equal(parsed.RUN_INTERVAL_HOURS, 3);
  assert.equal(parsed.MAX_RUNTIME_HOURS, 48);
  assert.equal(parsed.MAX_API_SPEND_USD, 2);
  assert.equal(parsed.DRY_RUN, false);
  assert.equal(parsed.DRY_RUN_USE_LLM, false);
  assert.equal(parsed.LLM_PARSE_MAX_PER_RUN, 0);
  assert.deepEqual(parsed.NITTER_BASE_URLS, [
    "https://nitter.poast.org",
    "https://nitter.privacydev.net",
    "https://nitter.tiekoetter.com",
  ]);
});

test("loadConfig parses DRY_RUN flag", () => {
  clearCachedConfig();
  const parsed = loadConfig(withEnv({ DRY_RUN: "true" }));

  assert.equal(parsed.DRY_RUN, true);
});

test("loadConfig allows disabling LLM parsing with zero cap", () => {
  clearCachedConfig();
  const parsed = loadConfig(withEnv({ LLM_PARSE_MAX_PER_RUN: "0" }));

  assert.equal(parsed.LLM_PARSE_MAX_PER_RUN, 0);
});

test("loadConfig parses comma-separated Nitter base URLs", () => {
  clearCachedConfig();
  const parsed = loadConfig(
    withEnv({
      NITTER_BASE_URLS:
        "https://nitter.example.com/, https://another-nitter.example",
    }),
  );

  assert.deepEqual(parsed.NITTER_BASE_URLS, [
    "https://nitter.example.com",
    "https://another-nitter.example",
  ]);
});

test("loadConfig throws a clear error for missing keys", () => {
  clearCachedConfig();

  assert.throws(
    () =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "telegram-token",
        TELEGRAM_CHAT_ID: "12345",
      }),
    /Invalid environment configuration/,
  );
});

test("loadConfig rejects non-positive integers", () => {
  clearCachedConfig();

  assert.throws(
    () =>
      loadConfig(
        withEnv({
          MAX_FOUNDERS_PER_RUN: "0",
        }),
      ),
    /MAX_FOUNDERS_PER_RUN: Must be a positive integer/,
  );
});

test("loadConfig rejects non-positive API spend limits", () => {
  clearCachedConfig();

  assert.throws(
    () =>
      loadConfig(
        withEnv({
          MAX_API_SPEND_USD: "0",
        }),
      ),
    /MAX_API_SPEND_USD: Must be a positive number/,
  );
});

test("loadConfig rejects negative LLM parse caps", () => {
  clearCachedConfig();

  assert.throws(
    () =>
      loadConfig(
        withEnv({
          LLM_PARSE_MAX_PER_RUN: "-1",
        }),
      ),
    /LLM_PARSE_MAX_PER_RUN: Must be a non-negative integer/,
  );
});
