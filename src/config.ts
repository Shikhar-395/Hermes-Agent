import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const positiveIntegerFromString = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, context) => {
      const parsed = Number(value);

      if (!Number.isInteger(parsed) || parsed <= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Must be a positive integer",
        });
        return z.NEVER;
      }

      return parsed;
    });

const nonNegativeIntegerFromString = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, context) => {
      const parsed = Number(value);

      if (!Number.isInteger(parsed) || parsed < 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Must be a non-negative integer",
        });
        return z.NEVER;
      }

      return parsed;
    });

const positiveNumberFromString = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, context) => {
      const parsed = Number(value);

      if (!Number.isFinite(parsed) || parsed <= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Must be a positive number",
        });
        return z.NEVER;
      }

      return parsed;
    });

const urlListFromString = (fallback: string[]) =>
  z
    .string()
    .default(fallback.join(","))
    .transform((value, context) => {
      const urls = value
        .split(",")
        .map((entry) => entry.trim().replace(/\/+$/, ""))
        .filter(Boolean);

      if (urls.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Must include at least one URL",
        });
        return z.NEVER;
      }

      for (const url of urls) {
        try {
          const parsed = new URL(url);
          if (!["http:", "https:"].includes(parsed.protocol)) {
            throw new Error("Unsupported protocol");
          }
        } catch {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid URL: ${url}`,
          });
          return z.NEVER;
        }
      }

      return urls;
    });

const envSchema = z.object({
  DEEPSEEK_API_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  DRY_RUN: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  DRY_RUN_USE_LLM: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  LLM_PARSE_MAX_PER_RUN: nonNegativeIntegerFromString("0"),
  MAX_FOUNDERS_PER_RUN: positiveIntegerFromString("50"),
  RUN_INTERVAL_HOURS: positiveIntegerFromString("3"),
  MAX_RUNTIME_HOURS: positiveIntegerFromString("48"),
  MAX_API_SPEND_USD: positiveNumberFromString("2.00"),
  NITTER_BASE_URLS: urlListFromString([
    "https://nitter.poast.org",
    "https://nitter.privacydev.net",
    "https://nitter.tiekoetter.com",
  ]),
});

export type Config = z.infer<typeof envSchema>;

let cachedConfig: Config | null = null;

export function clearCachedConfig(): void {
  cachedConfig = null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  cachedConfig = parsed.data;
  return cachedConfig;
}

export const config: Config = new Proxy({} as Config, {
  get(_target, property) {
    return loadConfig()[property as keyof Config];
  },
});
