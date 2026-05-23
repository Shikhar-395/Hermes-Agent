import { loadConfig } from "./config.js";
import { closeDb, database, initDb } from "./database.js";
import { logger } from "./logger.js";
import {
  createDefaultScheduler,
  initializeRuntimeWindowState,
} from "./scheduler.js";
import { createTelegramService } from "./telegram.js";

async function main(): Promise<void> {
  const loadedConfig = loadConfig();
  initDb();
  initializeRuntimeWindowState(database, new Date());

  const telegram = createTelegramService();
  await telegram.sendStartupMessage(
    loadedConfig.RUN_INTERVAL_HOURS,
    loadedConfig.MAX_RUNTIME_HOURS,
  );

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
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  logger.error(`Hermes Agent failed to start: ${message}`);
  closeDb();
  process.exit(1);
});
