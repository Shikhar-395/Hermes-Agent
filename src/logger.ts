import fs from "node:fs";
import path from "node:path";
import winston from "winston";

export const ROOT_DIR = process.cwd();
export const LOG_DIR = path.resolve(ROOT_DIR, "logs");
export const DATA_DIR = path.resolve(ROOT_DIR, "data");

for (const directory of [LOG_DIR, DATA_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(
          ({ level, message, timestamp }) =>
            `${timestamp} ${level}: ${message}`,
        ),
      ),
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, "hermes-agent.log"),
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, "hermes-error.log"),
      level: "error",
    }),
  ],
});
