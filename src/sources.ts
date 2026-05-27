import type { ScraperSource } from "./types.js";

export interface FounderSourceDefinition {
  source: ScraperSource;
  label: string;
  startupWhoSlug?: string;
  officialUrls?: string[];
}

export const SOURCE_REGISTRY: FounderSourceDefinition[] = [
  {
    source: "yc_directory",
    label: "Y Combinator",
    officialUrls: ["https://www.ycombinator.com/companies"],
  },
  {
    source: "techstars",
    label: "Techstars",
    startupWhoSlug: "techstars",
    officialUrls: ["https://www.techstars.com/portfolio"],
  },
  {
    source: "500global",
    label: "500 Global",
    startupWhoSlug: "500global",
    officialUrls: ["https://500.co/portfolio"],
  },
  {
    source: "sequoia_arc",
    label: "Sequoia Arc",
    officialUrls: [
      "https://www.sequoiacap.com/arc/",
      "https://sequoiacap.com/article/vision-grit-growth-introducing-the-next-arc-founders/",
      "https://sequoiacap.com/article/arc-spring-23-announcement/",
    ],
  },
  {
    source: "a16z",
    label: "a16z",
    startupWhoSlug: "a16z",
    officialUrls: ["https://a16z.com/portfolio/", "https://a16z.com/speedrun/"],
  },
  {
    source: "antler",
    label: "Antler",
    startupWhoSlug: "antler",
    officialUrls: ["https://www.antler.co/portfolio"],
  },
  {
    source: "entrepreneur_first",
    label: "Entrepreneur First",
    officialUrls: ["https://www.joinef.com/companies/"],
  },
  {
    source: "plug_and_play",
    label: "Plug and Play",
    officialUrls: ["https://www.plugandplaytechcenter.com/ventures/portfolio/"],
  },
  {
    source: "alchemist",
    label: "Alchemist",
    officialUrls: ["https://www.alchemistaccelerator.com/portfolio"],
  },
  {
    source: "neo",
    label: "Neo",
    officialUrls: ["https://www.neo.com/"],
  },
  {
    source: "pear_vc",
    label: "Pear VC",
    officialUrls: ["https://pear.vc/companies/"],
  },
  {
    source: "hax",
    label: "HAX",
    officialUrls: ["https://hax.co/"],
  },
  {
    source: "on_deck",
    label: "On Deck",
    officialUrls: ["https://www.beondeck.com/"],
  },
  {
    source: "google_for_startups",
    label: "Google for Startups",
    officialUrls: [
      "https://startup.google.com/programs/accelerator/",
      "https://startup.google.com/alumni/directory/",
    ],
  },
  {
    source: "microsoft_for_startups",
    label: "Microsoft for Startups",
    officialUrls: ["https://www.microsoft.com/en-us/startups"],
  },
  {
    source: "nvidia_inception",
    label: "NVIDIA Inception",
    officialUrls: ["https://www.nvidia.com/en-us/startups/"],
  },
  {
    source: "lightspeed",
    label: "Lightspeed",
    officialUrls: ["https://lsvp.com/companies/", "https://lsip.com/companies/"],
  },
  {
    source: "benchmark",
    label: "Benchmark",
    officialUrls: ["https://www.benchmark.com/"],
  },
  {
    source: "general_catalyst",
    label: "General Catalyst",
    startupWhoSlug: "generalcatalyst",
    officialUrls: ["https://www.generalcatalyst.com/portfolio"],
  },
  {
    source: "founders_fund",
    label: "Founders Fund",
    startupWhoSlug: "foundersfund",
    officialUrls: ["https://foundersfund.com/portfolio/"],
  },
  {
    source: "greylock",
    label: "Greylock",
    startupWhoSlug: "greylock",
    officialUrls: ["https://greylock.com/portfolio/"],
  },
  {
    source: "accel",
    label: "Accel",
    officialUrls: [
      "https://www.accel.com/companies",
      "https://www.accel.com/noteworthies/backing-indian-founders-with-global-ambition-announcing-our-ai-2025-cohort-introducing-accel-atoms-x",
    ],
  },
  {
    source: "index_ventures",
    label: "Index Ventures",
    startupWhoSlug: "indexventures",
    officialUrls: ["https://www.indexventures.com/companies/"],
  },
  {
    source: "seedcamp",
    label: "Seedcamp",
    startupWhoSlug: "seedcamp",
  },
  { source: "hn_launch", label: "Launch HN" },
  { source: "twitter", label: "Twitter" },
  { source: "producthunt", label: "Product Hunt" },
];

export const ALL_SOURCES = SOURCE_REGISTRY.map(
  (definition) => definition.source,
) as ScraperSource[];

export const PUBLIC_PAGE_SOURCES = SOURCE_REGISTRY.filter(
  (definition) => definition.source !== "yc_directory" && Boolean(definition.startupWhoSlug || definition.officialUrls?.length),
);

const SOURCE_LABELS = Object.fromEntries(
  SOURCE_REGISTRY.map((definition) => [definition.source, definition.label]),
) as Record<ScraperSource, string>;

export function getSourceLabel(source: ScraperSource): string {
  return SOURCE_LABELS[source] ?? source;
}

export function getSourceDefinition(
  source: ScraperSource,
): FounderSourceDefinition | null {
  return SOURCE_REGISTRY.find((definition) => definition.source === source) ?? null;
}
