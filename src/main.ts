import { loadConfig, type Config } from "./config.js";
import { closeDb, database, initDb } from "./database.js";
import { logger } from "./logger.js";
import { testDeepSeekApi } from "./parser.js";
import {
  createDefaultScheduler,
  initializeRuntimeWindowState,
} from "./scheduler.js";
import { createTelegramService, type TelegramService } from "./telegram.js";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runValidationStep<T>(
  label: string,
  stepName: string,
  action: () => Promise<T> | T,
): Promise<T> {
  console.log(label);

  try {
    return await action();
  } catch (error) {
    const message = `❌ ${stepName} failed: ${getErrorMessage(error)}`;
    console.error(message);
    logger.error(message);
    throw new Error(message);
  }
}

async function validateStartup(): Promise<{
  loadedConfig: Config;
  telegram: TelegramService;
}> {
  const loadedConfig = await runValidationStep(
    "🔍 Validating config...",
    "Validating config",
    () => loadConfig(),
  );

  await runValidationStep(
    "🗄️  Initialising database...",
    "Initialising database",
    () => {
      initDb();
      initializeRuntimeWindowState(database, new Date());
    },
  );

  const telegram = createTelegramService();
  await runValidationStep(
    "🤖 Testing Telegram...",
    "Testing Telegram",
    async () => {
      const sent = await telegram.sendTestPing();
      if (!sent) {
        throw new Error("Telegram test ping returned false");
      }
    },
  );

  const shouldTestDeepSeek =
    loadedConfig.LLM_PARSE_MAX_PER_RUN > 0 &&
    (!loadedConfig.DRY_RUN || loadedConfig.DRY_RUN_USE_LLM);

  if (!shouldTestDeepSeek) {
    console.log("🧠 Skipping DeepSeek API ping because paid parsing is disabled");
  } else {
    await runValidationStep(
      "🧠 Testing DeepSeek API...",
      "Testing DeepSeek API",
      () => testDeepSeekApi(),
    );
  }

  console.log("✅ All systems ready — starting Hermes Agent");
  return { loadedConfig, telegram };
}

async function main(): Promise<void> {
  const { telegram } = await validateStartup();
  const scheduler = createDefaultScheduler(telegram);
  let shuttingDown = false;

  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down Hermes Agent`);

    await scheduler.stop(signal);
    await telegram.sendShutdownMessage();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void gracefulShutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(
      `Unhandled promise rejection: ${
        reason instanceof Error ? reason.stack ?? reason.message : String(reason)
      }`,
    );
  });

  process.on("uncaughtException", (error) => {
    logger.error(`Uncaught exception: ${error.stack ?? error.message}`);
  });

  await scheduler.start();
}

main().catch((error) => {
  const message = getErrorMessage(error);
  console.error(`Hermes Agent did not start: ${message}`);
  logger.error(`Hermes Agent failed to start: ${message}`);
  closeDb();
  process.exit(1);
});
