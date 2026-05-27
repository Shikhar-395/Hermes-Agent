import OpenAI from "openai";

import { config } from "./config.js";
import {
  calculateApiCost,
  getTotalSpend,
  logApiUsage,
  OPENROUTER_DEEPSEEK_MODEL,
} from "./database.js";
import { logger } from "./logger.js";
import type { DeepSeekResponse, RawCandidate } from "./types.js";

interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface DeepSeekClientLike {
  chat: {
    completions: {
      create: (payload: Record<string, unknown>) => Promise<{
        choices?: Array<{
          message?: {
            content?: string | null;
          };
        }>;
        usage?: DeepSeekUsage;
      }>;
    };
  };
}

let deepSeekClient: DeepSeekClientLike | null = null;

export class ApiSpendLimitReachedError extends Error {
  public constructor(
    public readonly totalSpend: number,
    public readonly limit: number,
  ) {
    super(`API spend limit reached: $${totalSpend.toFixed(4)}`);
    this.name = "ApiSpendLimitReachedError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getClient(): DeepSeekClientLike {
  if (!deepSeekClient) {
    deepSeekClient = new OpenAI({
      apiKey: config.DEEPSEEK_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    }) as unknown as DeepSeekClientLike;
  }

  return deepSeekClient;
}

export function extractJsonObjectFromResponse(
  content: string,
): DeepSeekResponse | null {
  const trimmed = content.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? jsonMatch[0] : trimmed;

  try {
    const parsed = JSON.parse(candidate) as DeepSeekResponse;
    if (typeof parsed.isFounder !== "boolean") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function buildUserPrompt(rawText: string): string {
  return [
    "Extract founder information from the following raw text.",
    "Respond with a single raw JSON object only.",
    "Required keys: founderName, companyName, companyDescription, linkedinUrl, twitterHandle, website, ycProfileUrl, batch, isFounder.",
    "Use null for unknown nullable values.",
    "If the subject is not a founder or is too ambiguous, set isFounder to false.",
    "",
    rawText,
  ].join("\n");
}

function trackApiUsage(usage: DeepSeekUsage | undefined): void {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const callCost = calculateApiCost(promptTokens, completionTokens);

  logApiUsage(promptTokens, completionTokens);

  const totalSpend = getTotalSpend();
  console.log(
    `💰 This call: $${callCost.toFixed(6)} | Total spent: $${totalSpend.toFixed(4)} / $${config.MAX_API_SPEND_USD.toFixed(2)}`,
  );

  if (totalSpend >= config.MAX_API_SPEND_USD) {
    console.log("🛑 Spend limit reached — shutting down");
    throw new ApiSpendLimitReachedError(totalSpend, config.MAX_API_SPEND_USD);
  }
}

export async function testDeepSeekApi(options?: {
  client?: DeepSeekClientLike;
}): Promise<void> {
  const client = options?.client ?? getClient();
  const response = await client.chat.completions.create({
    model: OPENROUTER_DEEPSEEK_MODEL,
    temperature: 0,
    max_tokens: 1,
    messages: [
      {
        role: "user",
        content: "Reply OK.",
      },
    ],
  });

  trackApiUsage(response.usage);
}

export async function parseFounderData(
  rawText: string,
  options?: {
    client?: DeepSeekClientLike;
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<DeepSeekResponse | null> {
  const client = options?.client ?? getClient();
  const sleepFn = options?.sleepFn ?? sleep;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Awaited<
      ReturnType<DeepSeekClientLike["chat"]["completions"]["create"]>
    >;

    try {
      response = await client.chat.completions.create({
        model: OPENROUTER_DEEPSEEK_MODEL,
        temperature: 0.1,
        max_tokens: 1000,
        messages: [
          {
            role: "system",
            content:
              "You extract structured founder data. Respond only in raw valid JSON with no markdown or explanation.",
          },
          {
            role: "user",
            content: buildUserPrompt(rawText),
          },
        ],
      });
    } catch (error) {
      logger.error(
        `DeepSeek parsing failed on attempt ${attempt}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      if (attempt === 1) {
        await sleepFn(3000);
        continue;
      }

      return null;
    }

    trackApiUsage(response.usage);

    const content = response.choices?.[0]?.message?.content ?? "";
    const parsed = extractJsonObjectFromResponse(content);

    if (parsed) {
      return parsed;
    }

    if (attempt === 1) {
      logger.warn("DeepSeek returned non-JSON or invalid JSON output; retrying");
      await sleepFn(1000);
      continue;
    }

    logger.warn("DeepSeek returned non-JSON or invalid JSON output after retry");
    return null;
  }

  return null;
}

export function buildCandidatePrompt(candidate: RawCandidate): string {
  return [
    `Source: ${candidate.source}`,
    candidate.companyName ? `Company: ${candidate.companyName}` : null,
    candidate.founderName ? `Founder: ${candidate.founderName}` : null,
    candidate.companyDescription
      ? `Description: ${candidate.companyDescription}`
      : null,
    candidate.website ? `Website: ${candidate.website}` : null,
    candidate.twitterHandle ? `Twitter Handle: ${candidate.twitterHandle}` : null,
    candidate.ycProfileUrl ? `Profile URL: ${candidate.ycProfileUrl}` : null,
    candidate.batch ? `Batch: ${candidate.batch}` : null,
    `Raw Text: ${candidate.rawText}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function parseRawCandidate(
  candidate: RawCandidate,
  options?: {
    client?: DeepSeekClientLike;
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<DeepSeekResponse | null> {
  return parseFounderData(buildCandidatePrompt(candidate), options);
}
