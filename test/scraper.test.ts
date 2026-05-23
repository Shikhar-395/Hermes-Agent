import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  extractNitterCandidatesFromHtml,
  extractProductHuntCandidatesFromHtml,
  extractYcCompanyCardsFromHtml,
  extractYcFounderDetailsFromHtml,
  filterHnLaunchHits,
} from "../src/scraper.js";

const FIXTURE_DIR = path.resolve(process.cwd(), "test/fixtures");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

test("extractYcCompanyCardsFromHtml finds company cards and batch info", () => {
  const cards = extractYcCompanyCardsFromHtml(
    fixture("yc-directory.html"),
    "https://www.ycombinator.com/companies?batch=S25",
  );

  assert.equal(cards.length, 2);
  assert.equal(cards[0]?.companyName, "Atlas AI");
  assert.equal(cards[0]?.batch, "S25");
});

test("extractYcFounderDetailsFromHtml returns structured founders", () => {
  const founders = extractYcFounderDetailsFromHtml(
    fixture("yc-detail.html"),
    "https://www.ycombinator.com/companies/atlas-ai",
    "S25",
    {
      companyName: "Atlas AI",
      companyDescription: "AI operating system for industrial analytics",
      website: "https://atlasai.com",
    },
  );

  assert.deepEqual(
    founders.map((founder) => founder.founderName),
    ["Alice Johnson", "Marcus Lee"],
  );
  assert.equal(founders[0]?.website, "https://atlasai.com");
});

test("filterHnLaunchHits keeps Launch HN stories only", () => {
  const payload = JSON.parse(fixture("hn.json")) as {
    hits: Array<{
      title: string;
      url: string;
      author: string;
      story_text: string;
    }>;
  };

  const candidates = filterHnLaunchHits(payload.hits);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.companyName, "Orbit Ledger");
});

test("extractNitterCandidatesFromHtml parses tweet text and handles", () => {
  const candidates = extractNitterCandidatesFromHtml(
    fixture("nitter.html"),
    "just got into YC",
  );

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.twitterHandle, "mayachen");
  assert.match(candidates[0]?.rawText ?? "", /YC S25/);
});

test("extractProductHuntCandidatesFromHtml filters to this week", () => {
  const candidates = extractProductHuntCandidatesFromHtml(
    fixture("producthunt.html"),
    new Date("2026-05-23T00:00:00.000Z"),
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.companyName, "LaunchPad AI");
  assert.equal(candidates[0]?.founderName, "Darius Cole");
});
