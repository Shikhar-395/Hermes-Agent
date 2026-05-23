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

const envSchema = z.object({
  DEEPSEEK_API_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  HUNTER_API_KEY: z.string().min(1),
  MAX_FOUNDERS_PER_RUN: positiveIntegerFromString("50"),
  RUN_INTERVAL_HOURS: positiveIntegerFromString("3"),
  MAX_RUNTIME_HOURS: positiveIntegerFromString("48"),
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
