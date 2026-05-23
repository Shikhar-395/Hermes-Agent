export type ScraperSource =
  | "yc_directory"
  | "hn_launch"
  | "twitter"
  | "producthunt";

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
  source: Exclude<ScraperSource, "yc_directory">;
  rawText: string;
  founderName: string | null;
  companyName: string | null;
  companyDescription: string | null;
  website: string | null;
  ycProfileUrl: string | null;
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
}

export interface SourceQuotaMap {
  yc_directory: number;
  hn_launch: number;
  twitter: number;
  producthunt: number;
}
