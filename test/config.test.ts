import assert from "node:assert/strict";
import test from "node:test";

import { clearCachedConfig, loadConfig } from "../src/config.js";

const REQUIRED_ENV = {
  DEEPSEEK_API_KEY: "deepseek-key",
  TELEGRAM_BOT_TOKEN: "telegram-token",
  TELEGRAM_CHAT_ID: "12345",
  HUNTER_API_KEY: "hunter-key",
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
});

test("loadConfig throws a clear error for missing keys", () => {
  clearCachedConfig();

  assert.throws(
    () =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "telegram-token",
        TELEGRAM_CHAT_ID: "12345",
        HUNTER_API_KEY: "hunter-key",
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
