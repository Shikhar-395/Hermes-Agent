import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  calculateApiCost,
  closeDb,
  createRun,
  finishRun,
  getAgentState,
  getStats,
  getTotalSpend,
  getUnsentFounders,
  initDb,
  insertFounder,
  isDuplicate,
  logApiUsage,
  markAsSent,
  setAgentState,
  incrementRunStat,
} from "../src/database.js";

function createTempDbPath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "hermes-db-"));
  return path.join(directory, "hermes.sqlite");
}

test("database inserts founders, tracks duplicates, and manages unsent state", () => {
  closeDb();
  initDb(createTempDbPath());

  const founder = insertFounder({
    founderName: "Alice Johnson",
    companyName: "Atlas AI",
    companyDescription: "AI operating system",
    linkedinUrl: null,
    twitterUrl: null,
    twitterHandle: null,
    email: null,
    website: "https://atlasai.com",
    ycProfileUrl: "https://www.ycombinator.com/companies/atlas-ai",
    batch: "S25",
    source: "yc_directory",
    sentAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  assert.ok(founder.id);
  assert.equal(isDuplicate("Alice Johnson", "Atlas AI"), true);
  assert.equal(getUnsentFounders().length, 1);

  markAsSent(founder.id!);
  assert.equal(getUnsentFounders().length, 0);

  closeDb();
});

test("database persists run stats and agent state", () => {
  closeDb();
  initDb(createTempDbPath());

  const runId = createRun("2026-01-01T00:00:00.000Z");
  incrementRunStat(runId, "foundersFound", 2);
  incrementRunStat(runId, "foundersSent", 1);
  incrementRunStat(runId, "duplicatesSkipped", 3);
  incrementRunStat(runId, "errors", 1);

  const stats = finishRun(runId);
  assert.deepEqual(stats, {
    startedAt: "2026-01-01T00:00:00.000Z",
    foundersFound: 2,
    foundersSent: 1,
    duplicatesSkipped: 3,
    errors: 1,
  });

  setAgentState("runtime_started_at", "2026-01-01T00:00:00.000Z");
  assert.equal(
    getAgentState("runtime_started_at")?.value,
    "2026-01-01T00:00:00.000Z",
  );

  assert.deepEqual(getStats(), stats);
  closeDb();
});

test("database logs API usage and totals spend", () => {
  closeDb();
  initDb(createTempDbPath());

  logApiUsage(1_000_000, 1_000_000);
  logApiUsage(500_000, 250_000);

  const expectedSpend =
    calculateApiCost(1_000_000, 1_000_000) +
    calculateApiCost(500_000, 250_000);

  assert.equal(getTotalSpend(), expectedSpend);
  closeDb();
});
