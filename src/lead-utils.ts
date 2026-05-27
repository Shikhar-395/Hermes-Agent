import { getSourceLabel } from "./sources.js";
import type { Founder, RawCandidate, ScraperSource } from "./types.js";

export const RECENT_FUNDING_CUTOFF = new Date("2026-02-25T00:00:00.000Z");

const TECH_CATEGORY_KEYWORDS: Array<[string, RegExp]> = [
  ["AI", /\b(ai|artificial intelligence|machine learning|ml|llm|agent|copilot|computer vision|generative)\b/i],
  ["Developer Tools", /\b(devtool|developer|api|sdk|code|software engineer|debug|github|ci\/cd|infrastructure as code)\b/i],
  ["Infrastructure", /\b(infrastructure|cloud|platform|database|data pipeline|compute|serverless|observability|security operations)\b/i],
  ["Cybersecurity", /\b(cybersecurity|security|fraud|identity|risk|threat|vulnerability)\b/i],
  ["Data", /\b(data|analytics|warehouse|etl|search|knowledge|vector|semantic)\b/i],
  ["SaaS", /\b(saas|workflow|automation|crm|erp|b2b|b2b software|enterprise|enterprise software|software)\b/i],
  ["FinTech Software", /\b(fintech|payments|banking|accounting|finance|payroll|tax|insurance)\b/i],
  ["Robotics", /\b(robot|robotics|drone|autonomous|hardware|manufacturing|industrial|deep tech)\b/i],
  ["Health Tech", /\b(health tech|healthcare|medical|clinical|biotech|diagnostic)\b/i],
];

const RAW_DISCOVERY_SOURCES = new Set<ScraperSource>([
  "hn_launch",
  "twitter",
  "producthunt",
]);

const ENGINEERING_KEYWORDS =
  /\b(engineer|developer|full[-\s]?stack|backend|front[-\s]?end|software|platform|infrastructure|ai engineer|ml engineer|machine learning engineer|data engineer|devops|site reliability)\b/i;

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function founderSearchText(founder: Founder): string {
  return [
    founder.companyName,
    founder.companyDescription,
    founder.fundingSource,
    founder.fundingRound,
    founder.techCategory,
    founder.batch,
  ]
    .map(cleanText)
    .filter(Boolean)
    .join("\n");
}

export function detectTechCategory(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text) {
    return null;
  }

  for (const [category, pattern] of TECH_CATEGORY_KEYWORDS) {
    if (pattern.test(text)) {
      return category;
    }
  }

  return null;
}

export function hasEngineeringHiringSignal(
  value: string | null | undefined,
): boolean {
  return ENGINEERING_KEYWORDS.test(cleanText(value));
}

export function hasFounderContact(founder: Founder): boolean {
  return Boolean(founder.linkedinUrl || founder.twitterUrl || founder.twitterHandle);
}

function isStructuredPublicSource(founder: Founder): boolean {
  return !RAW_DISCOVERY_SOURCES.has(founder.source);
}

export function isTechRelatedFounder(founder: Founder): boolean {
  return Boolean(founder.techCategory || detectTechCategory(founderSearchText(founder)));
}

export function isRecentFounder(
  founder: Founder,
  cutoff = RECENT_FUNDING_CUTOFF,
): boolean {
  const fundingDate = cleanText(founder.fundingDate);
  if (fundingDate) {
    const parsed = new Date(fundingDate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed >= cutoff;
    }
  }

  const recencyText = [
    founder.batch,
    founder.companyDescription,
    founder.fundingSource,
    founder.sourceProfileUrl,
    founder.ycProfileUrl,
  ]
    .map(cleanText)
    .filter(Boolean)
    .join(" ");

  return (
    /\b(2026|spring 2026|winter 2026|s26|w26|current|in program now|new cohort)\b/i.test(
      recencyText,
    ) ||
    (isStructuredPublicSource(founder) &&
      /\bstartupwho listing\b/i.test(cleanText(founder.fundingRound)))
  );
}

export function isLikelyTechCandidate(candidate: RawCandidate): boolean {
  return Boolean(
    detectTechCategory(
      [
        candidate.companyName,
        candidate.companyDescription,
        candidate.rawText,
        candidate.techCategory,
      ]
        .map(cleanText)
        .filter(Boolean)
        .join("\n"),
    ),
  );
}

export function prepareFounderLead(founder: Founder): Founder {
  const sourceProfileUrl =
    founder.sourceProfileUrl ?? founder.ycProfileUrl ?? founder.website ?? null;
  const fundingSource = founder.fundingSource ?? getSourceLabel(founder.source);
  const techCategory =
    founder.techCategory ?? detectTechCategory(founderSearchText(founder));

  return {
    ...founder,
    sourceProfileUrl,
    fundingSource,
    techCategory,
    engineeringHiringSignal: Boolean(founder.engineeringHiringSignal),
  };
}

export function shouldConsiderFounderForLead(founder: Founder): boolean {
  const prepared = prepareFounderLead(founder);
  return isTechRelatedFounder(prepared) && isRecentFounder(prepared);
}

export function shouldSendFounderLead(founder: Founder): boolean {
  const prepared = prepareFounderLead(founder);
  return shouldConsiderFounderForLead(prepared) && hasFounderContact(prepared);
}

export function getFounderLeadRejectionReasons(founder: Founder): string[] {
  const prepared = prepareFounderLead(founder);
  const reasons: string[] = [];

  if (!isTechRelatedFounder(prepared)) {
    reasons.push("no tech/product signal");
  }

  if (!isRecentFounder(prepared)) {
    reasons.push("no recent funding/cohort signal");
  }

  if (!hasFounderContact(prepared)) {
    reasons.push("no founder LinkedIn/X found");
  }

  return reasons;
}

export function sortFounderLeads(founders: Founder[]): Founder[] {
  return [...founders].sort((left, right) => {
    const leftHiring = left.engineeringHiringSignal ? 1 : 0;
    const rightHiring = right.engineeringHiringSignal ? 1 : 0;
    if (leftHiring !== rightHiring) {
      return rightHiring - leftHiring;
    }

    const leftDate = left.fundingDate ? new Date(left.fundingDate).getTime() : 0;
    const rightDate = right.fundingDate ? new Date(right.fundingDate).getTime() : 0;
    return rightDate - leftDate;
  });
}
