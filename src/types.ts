export type ScraperSource =
  | "yc_directory"
  | "hn_launch"
  | "twitter"
  | "producthunt"
  | "techstars"
  | "antler"
  | "seedcamp"
  | "a16z"
  | "500global"
  | "sequoia_arc"
  | "entrepreneur_first"
  | "plug_and_play"
  | "alchemist"
  | "neo"
  | "pear_vc"
  | "hax"
  | "on_deck"
  | "google_for_startups"
  | "microsoft_for_startups"
  | "nvidia_inception"
  | "lightspeed"
  | "benchmark"
  | "general_catalyst"
  | "founders_fund"
  | "greylock"
  | "accel"
  | "index_ventures";

export interface Founder {
  id?: number;
  founderName: string;
  companyName: string;
  companyDescription: string | null;
  linkedinUrl: string | null;
  twitterUrl: string | null;
  twitterHandle: string | null;
  email: string | null;
  website: string | null;
  ycProfileUrl: string | null;
  sourceProfileUrl?: string | null;
  fundingSource?: string | null;
  fundingDate?: string | null;
  fundingRound?: string | null;
  techCategory?: string | null;
  careersUrl?: string | null;
  engineeringHiringSignal?: boolean;
  batch: string | null;
  source: ScraperSource;
  sentAt: string | null;
  createdAt: string;
}

export interface DeepSeekResponse {
  founderName: string;
  companyName: string;
  companyDescription: string | null;
  linkedinUrl: string | null;
  twitterHandle: string | null;
  website: string | null;
  ycProfileUrl: string | null;
  sourceProfileUrl?: string | null;
  batch: string | null;
  isFounder: boolean;
}

export interface EnrichedProfile extends Founder {
  email: string | null;
}

export interface RunStats {
  startedAt: string;
  foundersFound: number;
  foundersSent: number;
  duplicatesSkipped: number;
  errors: number;
}

export interface RawCandidate {
  source: ScraperSource;
  rawText: string;
  founderName: string | null;
  companyName: string | null;
  companyDescription: string | null;
  website: string | null;
  ycProfileUrl: string | null;
  sourceProfileUrl?: string | null;
  fundingSource?: string | null;
  fundingDate?: string | null;
  fundingRound?: string | null;
  techCategory?: string | null;
  careersUrl?: string | null;
  engineeringHiringSignal?: boolean;
  twitterHandle: string | null;
  batch: string | null;
}

export interface ParsedCandidate {
  source: RawCandidate["source"];
  rawCandidate: RawCandidate;
  parsed: DeepSeekResponse;
}

export interface RunRecord extends RunStats {
  id: number;
  completedAt: string | null;
}

export interface AgentState {
  key: string;
  value: string;
  updatedAt: string;
}

export type RunStatField = Exclude<keyof RunStats, "startedAt">;

export interface ScrapeOptions {
  maxResults?: number;
  visitedUrls?: Set<string>;
  dryRun?: boolean;
}

export type SourceQuotaMap = Record<ScraperSource, number>;
