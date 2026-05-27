import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  extractNitterCandidatesFromHtml,
  extractOfficialPortfolioFoundersFromHtml,
  extractProductHuntCandidatesFromHtml,
  extractStartupWhoAcceleratorFoundersFromHtml,
  extractYcCompaniesFromAlgoliaPayload,
  extractYcCompanyCardsFromHtml,
  extractYcFounderDetailsFromHtml,
  extractYcFoundersFromAlgoliaPayload,
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

test("extractYcFounderDetailsFromHtml prefers YC meta founder names over page chrome", () => {
  const founders = extractYcFounderDetailsFromHtml(
    `<!doctype html>
    <html>
      <head>
        <meta name="description" content="Actuarial intelligence. Founded in 2025 by Paulien Jeunesse and Alex Musy, Huscarl has 2 employees based in San Francisco." />
      </head>
      <body>
        <nav>Apply YC Interview Guide FAQ People YC Blog Companies Startup</nav>
        <h1>Huscarl</h1>
      </body>
    </html>`,
    "https://www.ycombinator.com/companies/huscarl",
    "Spring 2026",
    {
      companyName: "Huscarl",
      companyDescription: "Actuarial intelligence",
      website: "https://www.huscarl.io/",
    },
  );

  assert.deepEqual(
    founders.map((founder) => founder.founderName),
    ["Paulien Jeunesse", "Alex Musy"],
  );
});

test("extractYcFoundersFromAlgoliaPayload maps Algolia hits to founders", () => {
  const founders = extractYcFoundersFromAlgoliaPayload({
    hits: [
      {
        name: "Fallback AI",
        one_liner: "AI support agents for industrial teams",
        long_description:
          "Fallback AI helps industrial support teams triage field issues.",
        founders: [
          { name: "Priya Shah" },
          { first_name: "Noah", last_name: "Kim" },
        ],
        website: "fallback.ai",
        slug: "fallback-ai",
        batch: "Spring 2026",
      },
    ],
  });

  assert.deepEqual(
    founders.map((founder) => founder.founderName),
    ["Priya Shah", "Noah Kim"],
  );
  assert.equal(founders[0]?.companyName, "Fallback AI");
  assert.equal(
    founders[0]?.companyDescription,
    "AI support agents for industrial teams\n\nFallback AI helps industrial support teams triage field issues.",
  );
  assert.equal(founders[0]?.website, "https://fallback.ai");
  assert.equal(
    founders[0]?.ycProfileUrl,
    "https://www.ycombinator.com/companies/fallback-ai",
  );
  assert.equal(founders[0]?.batch, "Spring 2026");
});

test("extractYcCompaniesFromAlgoliaPayload maps Algolia hits without founders", () => {
  const companies = extractYcCompaniesFromAlgoliaPayload({
    hits: [
      {
        name: "HeyClicky",
        one_liner: "An AI buddy that lives on your Mac.",
        long_description: "HeyClicky sits right next to your cursor.",
        website: "https://heyclicky.com/",
        slug: "heyclicky",
        batch: "Spring 2026",
      },
    ],
  });

  assert.equal(companies.length, 1);
  assert.equal(companies[0]?.companyName, "HeyClicky");
  assert.equal(
    companies[0]?.ycProfileUrl,
    "https://www.ycombinator.com/companies/heyclicky",
  );
  assert.equal(companies[0]?.batch, "Spring 2026");
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

test("extractStartupWhoAcceleratorFoundersFromHtml maps accelerator rows with founders", () => {
  const founders = extractStartupWhoAcceleratorFoundersFromHtml(
    `
      <table>
        <tbody>
          <tr>
            <td><span class="font-medium">Alloy</span></td>
            <td>B2B</td>
            <td>Brooklyn, United States</td>
            <td><span>Tommy Nicholas</span></td>
            <td>
              <a href="https://alloy.co">alloy.co</a>
              <a href="https://www.linkedin.com/in/tommy-nicholas">LinkedIn</a>
            </td>
            <td>2026-04-15</td>
          </tr>
          <tr>
            <td><span class="font-medium">No Founder Co</span></td>
            <td>Fintech</td>
            <td>San Francisco, United States</td>
            <td><span>—</span></td>
            <td><a href="https://nofounder.example">nofounder.example</a></td>
          </tr>
        </tbody>
      </table>
    `,
    { source: "techstars", slug: "techstars", label: "Techstars" },
  );

  assert.equal(founders.length, 1);
  assert.equal(founders[0]?.founderName, "Tommy Nicholas");
  assert.equal(founders[0]?.companyName, "Alloy");
  assert.match(founders[0]?.companyDescription ?? "", /Accelerator: Techstars/);
  assert.equal(founders[0]?.website, "https://alloy.co");
  assert.equal(founders[0]?.source, "techstars");
  assert.equal(
    founders[0]?.linkedinUrl,
    "https://www.linkedin.com/in/tommy-nicholas",
  );
  assert.equal(founders[0]?.fundingSource, "Techstars");
  assert.equal(founders[0]?.fundingDate, "2026-04-15");
});

test("extractOfficialPortfolioFoundersFromHtml maps dated portfolio cards with founder contacts", () => {
  const founders = extractOfficialPortfolioFoundersFromHtml(
    `
      <html>
        <head>
          <meta property="article:published_time" content="2026-04-20T12:00:00.000Z" />
        </head>
        <body>
          <article>
            <h2>VectorPilot</h2>
            <p>AI developer infrastructure for autonomous data pipelines. Spring 2026 cohort.</p>
            <p>Asha Rao, Co-Founder and CEO</p>
            <a href="https://vectorpilot.ai">Website</a>
            <a href="https://www.linkedin.com/in/asha-rao">Asha LinkedIn</a>
            <a href="/companies/vectorpilot">Profile</a>
          </article>
        </body>
      </html>
    `,
    {
      source: "pear_vc",
      label: "Pear VC",
      officialUrls: ["https://pear.vc/companies/"],
    },
    "https://pear.vc/companies/",
  );

  assert.equal(founders.length, 1);
  assert.equal(founders[0]?.founderName, "Asha Rao");
  assert.equal(founders[0]?.companyName, "VectorPilot");
  assert.equal(founders[0]?.linkedinUrl, "https://www.linkedin.com/in/asha-rao");
  assert.equal(founders[0]?.sourceProfileUrl, "https://pear.vc/companies/vectorpilot");
  assert.equal(founders[0]?.fundingSource, "Pear VC");
  assert.equal(founders[0]?.techCategory, "AI");
});
