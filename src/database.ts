import Database from "better-sqlite3";
import path from "node:path";

import { DATA_DIR, logger } from "./logger.js";
import type {
  AgentState,
  Founder,
  RunRecord,
  RunStatField,
  RunStats,
} from "./types.js";

export interface DatabaseAdapter {
  initDb(): void;
  closeDb(): void;
  isDuplicate(founderName: string, companyName: string): boolean;
  insertFounder(founder: Omit<Founder, "id">): Founder;
  markAsSent(id: number, sentAt?: string): void;
  logApiUsage(tokensInput: number, tokensOutput: number): void;
  getTotalSpend(): number;
  getTotalFoundersFound(): number;
  getStats(): RunStats | null;
  createRun(startedAt?: string): number;
  incrementRunStat(runId: number, field: RunStatField, amount?: number): void;
  finishRun(runId: number, completedAt?: string): RunStats | null;
  getUnsentFounders(limit?: number): Founder[];
  getAgentState(key: string): AgentState | null;
  setAgentState(key: string, value: string): void;
}

type SqliteDatabase = InstanceType<typeof Database>;

let db: SqliteDatabase | null = null;
let currentDbPath: string | null = null;

export const OPENROUTER_DEEPSEEK_MODEL = "deepseek/deepseek-chat";
const INPUT_COST_PER_MILLION_TOKENS_USD = 0.07;
const OUTPUT_COST_PER_MILLION_TOKENS_USD = 1.1;

function getNowIsoString(): string {
  return new Date().toISOString();
}

function getDb(filePath?: string): SqliteDatabase {
  if (!db) {
    const resolvedPath = filePath ?? path.join(DATA_DIR, "hermes.db");
    currentDbPath = resolvedPath;
    db = new Database(resolvedPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }

  return db;
}

function mapFounderRow(row: Record<string, unknown>): Founder {
  return {
    id: Number(row.id),
    founderName: String(row.founder_name),
    companyName: String(row.company_name),
    companyDescription:
      row.company_description === null ? null : String(row.company_description),
    linkedinUrl: row.linkedin_url === null ? null : String(row.linkedin_url),
    twitterUrl: row.twitter_url === null ? null : String(row.twitter_url),
    twitterHandle:
      row.twitter_handle === null ? null : String(row.twitter_handle),
    email: row.email === null ? null : String(row.email),
    website: row.website === null ? null : String(row.website),
    ycProfileUrl:
      row.yc_profile_url === null ? null : String(row.yc_profile_url),
    sourceProfileUrl:
      row.source_profile_url === null || row.source_profile_url === undefined
        ? null
        : String(row.source_profile_url),
    fundingSource:
      row.funding_source === null || row.funding_source === undefined
        ? null
        : String(row.funding_source),
    fundingDate:
      row.funding_date === null || row.funding_date === undefined
        ? null
        : String(row.funding_date),
    fundingRound:
      row.funding_round === null || row.funding_round === undefined
        ? null
        : String(row.funding_round),
    techCategory:
      row.tech_category === null || row.tech_category === undefined
        ? null
        : String(row.tech_category),
    careersUrl:
      row.careers_url === null || row.careers_url === undefined
        ? null
        : String(row.careers_url),
    engineeringHiringSignal:
      Number(row.engineering_hiring_signal ?? 0) === 1,
    batch: row.batch === null ? null : String(row.batch),
    source: String(row.source) as Founder["source"],
    sentAt: row.sent_at === null ? null : String(row.sent_at),
    createdAt: String(row.created_at),
  };
}

function mapRunRow(row: Record<string, unknown>): RunRecord {
  return {
    id: Number(row.id),
    startedAt: String(row.started_at),
    foundersFound: Number(row.founders_found),
    foundersSent: Number(row.founders_sent),
    duplicatesSkipped: Number(row.duplicates_skipped),
    errors: Number(row.errors),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  };
}

export function calculateApiCost(
  tokensInput: number,
  tokensOutput: number,
): number {
  const inputCost = (tokensInput / 1_000_000) * INPUT_COST_PER_MILLION_TOKENS_USD;
  const outputCost =
    (tokensOutput / 1_000_000) * OUTPUT_COST_PER_MILLION_TOKENS_USD;

  return inputCost + outputCost;
}

export function initDb(filePath?: string): void {
  const database = getDb(filePath);

  database.exec(`
    CREATE TABLE IF NOT EXISTS founders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      founder_name TEXT NOT NULL,
      company_name TEXT NOT NULL,
      company_description TEXT,
      linkedin_url TEXT,
      twitter_url TEXT,
      twitter_handle TEXT,
      email TEXT,
      website TEXT,
      yc_profile_url TEXT,
      source_profile_url TEXT,
      funding_source TEXT,
      funding_date TEXT,
      funding_round TEXT,
      tech_category TEXT,
      careers_url TEXT,
      engineering_hiring_signal INTEGER NOT NULL DEFAULT 0,
      batch TEXT,
      source TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(founder_name, company_name)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      founders_found INTEGER NOT NULL DEFAULT 0,
      founders_sent INTEGER NOT NULL DEFAULT 0,
      duplicates_skipped INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tokens_input INTEGER NOT NULL,
      tokens_output INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const founderColumns = new Set(
    (
      database.prepare(`PRAGMA table_info(founders)`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  const ensureFounderColumn = (name: string, definition: string): void => {
    if (!founderColumns.has(name)) {
      database.exec(`ALTER TABLE founders ADD COLUMN ${name} ${definition}`);
      founderColumns.add(name);
    }
  };

  ensureFounderColumn("source_profile_url", "TEXT");
  ensureFounderColumn("funding_source", "TEXT");
  ensureFounderColumn("funding_date", "TEXT");
  ensureFounderColumn("funding_round", "TEXT");
  ensureFounderColumn("tech_category", "TEXT");
  ensureFounderColumn("careers_url", "TEXT");
  ensureFounderColumn(
    "engineering_hiring_signal",
    "INTEGER NOT NULL DEFAULT 0",
  );

  logger.info(`SQLite initialized at ${currentDbPath}`);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    currentDbPath = null;
  }
}

export function isDuplicate(
  founderName: string,
  companyName: string,
): boolean {
  const database = getDb();
  const row = database
    .prepare(
      `
        SELECT 1
        FROM founders
        WHERE LOWER(founder_name) = LOWER(?)
          AND LOWER(company_name) = LOWER(?)
        LIMIT 1
      `,
    )
    .get(founderName.trim(), companyName.trim());

  return Boolean(row);
}

export function insertFounder(founder: Omit<Founder, "id">): Founder {
  const database = getDb();
  const createdAt = founder.createdAt || getNowIsoString();

  database
    .prepare(
      `
        INSERT OR IGNORE INTO founders (
          founder_name,
          company_name,
          company_description,
          linkedin_url,
          twitter_url,
          twitter_handle,
          email,
          website,
          yc_profile_url,
          source_profile_url,
          funding_source,
          funding_date,
          funding_round,
          tech_category,
          careers_url,
          engineering_hiring_signal,
          batch,
          source,
          sent_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      founder.founderName.trim(),
      founder.companyName.trim(),
      founder.companyDescription,
      founder.linkedinUrl,
      founder.twitterUrl,
      founder.twitterHandle,
      founder.email,
      founder.website,
      founder.ycProfileUrl,
      founder.sourceProfileUrl ?? founder.ycProfileUrl ?? founder.website ?? null,
      founder.fundingSource ?? null,
      founder.fundingDate ?? null,
      founder.fundingRound ?? null,
      founder.techCategory ?? null,
      founder.careersUrl ?? null,
      founder.engineeringHiringSignal ? 1 : 0,
      founder.batch,
      founder.source,
      founder.sentAt,
      createdAt,
    );

  const row = database
    .prepare(
      `
        SELECT *
        FROM founders
        WHERE LOWER(founder_name) = LOWER(?)
          AND LOWER(company_name) = LOWER(?)
        LIMIT 1
      `,
    )
    .get(founder.founderName.trim(), founder.companyName.trim()) as
    | Record<string, unknown>
    | undefined;

  if (!row) {
    throw new Error(
      `Failed to insert founder ${founder.founderName} at ${founder.companyName}`,
    );
  }

  return mapFounderRow(row);
}

export function markAsSent(id: number, sentAt = getNowIsoString()): void {
  getDb()
    .prepare(`UPDATE founders SET sent_at = ? WHERE id = ?`)
    .run(sentAt, id);
}

export function logApiUsage(tokensInput: number, tokensOutput: number): void {
  getDb()
    .prepare(
      `
        INSERT INTO api_usage (
          tokens_input,
          tokens_output,
          cost_usd,
          model,
          created_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
    )
    .run(
      tokensInput,
      tokensOutput,
      calculateApiCost(tokensInput, tokensOutput),
      OPENROUTER_DEEPSEEK_MODEL,
      getNowIsoString(),
    );
}

export function getTotalSpend(): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total_spend FROM api_usage`)
    .get() as Record<string, unknown> | undefined;

  return Number(row?.total_spend ?? 0);
}

export function getTotalFoundersFound(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS total_founders FROM founders`)
    .get() as Record<string, unknown> | undefined;

  return Number(row?.total_founders ?? 0);
}

export function createRun(startedAt = getNowIsoString()): number {
  const result = getDb()
    .prepare(
      `
        INSERT INTO runs (
          started_at,
          founders_found,
          founders_sent,
          duplicates_skipped,
          errors
        ) VALUES (?, 0, 0, 0, 0)
      `,
    )
    .run(startedAt);

  return Number(result.lastInsertRowid);
}

export function incrementRunStat(
  runId: number,
  field: RunStatField,
  amount = 1,
): void {
  const fieldMap: Record<RunStatField, string> = {
    foundersFound: "founders_found",
    foundersSent: "founders_sent",
    duplicatesSkipped: "duplicates_skipped",
    errors: "errors",
  };

  const column = fieldMap[field];

  getDb()
    .prepare(`UPDATE runs SET ${column} = ${column} + ? WHERE id = ?`)
    .run(amount, runId);
}

export function finishRun(
  runId: number,
  completedAt = getNowIsoString(),
): RunStats | null {
  const database = getDb();

  database
    .prepare(`UPDATE runs SET completed_at = ? WHERE id = ?`)
    .run(completedAt, runId);

  const row = database
    .prepare(`SELECT * FROM runs WHERE id = ? LIMIT 1`)
    .get(runId) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  const mapped = mapRunRow(row);
  return {
    startedAt: mapped.startedAt,
    foundersFound: mapped.foundersFound,
    foundersSent: mapped.foundersSent,
    duplicatesSkipped: mapped.duplicatesSkipped,
    errors: mapped.errors,
  };
}

export function getStats(): RunStats | null {
  const row = getDb()
    .prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  const mapped = mapRunRow(row);
  return {
    startedAt: mapped.startedAt,
    foundersFound: mapped.foundersFound,
    foundersSent: mapped.foundersSent,
    duplicatesSkipped: mapped.duplicatesSkipped,
    errors: mapped.errors,
  };
}

export function getUnsentFounders(limit?: number): Founder[] {
  const statement =
    typeof limit === "number"
      ? getDb().prepare(
          `
            SELECT *
            FROM founders
            WHERE sent_at IS NULL
            ORDER BY datetime(created_at) ASC
            LIMIT ?
          `,
        )
      : getDb().prepare(
          `
            SELECT *
            FROM founders
            WHERE sent_at IS NULL
            ORDER BY datetime(created_at) ASC
          `,
        );

  const rows = (typeof limit === "number" ? statement.all(limit) : statement.all()) as Array<
    Record<string, unknown>
  >;

  return rows.map(mapFounderRow);
}

export function getAgentState(key: string): AgentState | null {
  const row = getDb()
    .prepare(`SELECT * FROM agent_state WHERE key = ? LIMIT 1`)
    .get(key) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return {
    key: String(row.key),
    value: String(row.value),
    updatedAt: String(row.updated_at),
  };
}

export function setAgentState(key: string, value: string): void {
  getDb()
    .prepare(
      `
        INSERT INTO agent_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
    )
    .run(key, value, getNowIsoString());
}

export const database: DatabaseAdapter = {
  initDb,
  closeDb,
  isDuplicate,
  insertFounder,
  markAsSent,
  logApiUsage,
  getTotalSpend,
  getTotalFoundersFound,
  getStats,
  createRun,
  incrementRunStat,
  finishRun,
  getUnsentFounders,
  getAgentState,
  setAgentState,
};
