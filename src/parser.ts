import OpenAI from "openai";

import { config } from "./config.js";
import { logger } from "./logger.js";
import type { DeepSeekResponse, RawCandidate } from "./types.js";

export interface DeepSeekClientLike {
  chat: {
    completions: {
      create: (payload: Record<string, unknown>) => Promise<{
        choices?: Array<{
          message?: {
            content?: string | null;
          };
        }>;
      }>;
    };
  };
}

let deepSeekClient: DeepSeekClientLike | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getClient(): DeepSeekClientLike {
  if (!deepSeekClient) {
    deepSeekClient = new OpenAI({
      apiKey: config.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
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
    try {
      const response = await client.chat.completions.create({
        model: "deepseek-chat",
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

      const content = response.choices?.[0]?.message?.content ?? "";
      const parsed = extractJsonObjectFromResponse(content);

      if (!parsed) {
        logger.warn("DeepSeek returned non-JSON or invalid JSON output");
      }

      return parsed;
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
