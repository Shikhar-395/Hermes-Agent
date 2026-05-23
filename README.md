# Hermes Agent

Hermes Agent is a fully autonomous TypeScript research agent that discovers recently funded startup founders, enriches their public profiles, stores them in SQLite, and delivers structured founder updates to Telegram.

## What Hermes does

- Scrapes YC directory companies plus supporting signals from Launch HN, Nitter, and Product Hunt
- Normalizes unstructured candidate data with DeepSeek V3
- Enriches founders with LinkedIn, Twitter, and Hunter.io email lookup data
- Stores deduplicated founder records in SQLite
- Sends each founder as an individual Telegram message
- Runs on a schedule and stops automatically after the configured runtime window

## Prerequisites

- Node.js 20 or newer
- pnpm
- A Telegram account
- DeepSeek API access
- Hunter.io API access

## Setup

1. Get a DeepSeek API key.
   Visit [platform.deepseek.com](https://platform.deepseek.com), create an account, open the API section, and generate a key for `DEEPSEEK_API_KEY`.

2. Create a Telegram bot and get the bot token.
   Open Telegram, message `@BotFather`, run `/newbot`, follow the prompts, and copy the bot token into `TELEGRAM_BOT_TOKEN`.

3. Get your Telegram chat ID.
   Start a chat with your bot, send it a message, then open:
   `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   Find the `chat` object in the JSON response and copy its `id` into `TELEGRAM_CHAT_ID`.

4. Get a Hunter.io API key.
   Sign in at [hunter.io](https://hunter.io), open the API dashboard, and copy the key into `HUNTER_API_KEY`.

5. Install dependencies.

   ```bash
   pnpm install
   ```

6. Install Playwright Chromium.

   ```bash
   npx playwright install chromium
   ```

7. Create your environment file.

   ```bash
   cp .env.example .env
   ```

   Fill in all values before running the agent.

8. Start Hermes Agent.

   ```bash
   pnpm start
   ```

## Runtime behavior

- Hermes runs immediately on startup and then follows the configured schedule.
- Founder records are stored in `data/hermes.sqlite`.
- Logs are written to `logs/hermes-agent.log` and `logs/hermes-error.log`.
- If Telegram delivery fails, founders remain unsent in SQLite and are retried on later runs.
- The runtime window persists across process restarts until Hermes completes its configured max runtime.

## Development

Run the watcher:

```bash
pnpm dev
```

Run tests:

```bash
pnpm test
```

Run type-checking:

```bash
pnpm typecheck
```
