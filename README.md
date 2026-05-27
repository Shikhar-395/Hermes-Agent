# Hermes Agent

Hermes Agent is a fully autonomous TypeScript research agent that discovers recently funded startup founders, enriches their public profiles, stores them in SQLite, and delivers structured founder updates to Telegram.

## What Hermes does

- Scrapes YC plus public accelerator, VC, portfolio, and cohort pages before using paid parsing
- Covers YC, Techstars, 500 Global, Sequoia Arc, a16z, Antler, EF, Plug and Play, Alchemist, Neo, Pear VC, HAX, On Deck, Google for Startups, Microsoft for Startups, NVIDIA Inception, Lightspeed, Benchmark, General Catalyst, Founders Fund, Greylock, Accel, and Index Ventures
- Normalizes unstructured Launch HN, Nitter, and Product Hunt candidates with DeepSeek V3 only after deterministic tech filters pass
- Enriches founders with LinkedIn, X/Twitter, careers/apply URLs, and engineering hiring signals when discoverable
- Stores deduplicated founder records in SQLite
- Sends each founder as an individual Telegram message
- Runs on a schedule and stops automatically after the configured runtime window

## Prerequisites

- Node.js 20 or newer
- pnpm
- A Telegram account
- DeepSeek API access

## Setup

1. Get a DeepSeek API key.
   Visit [platform.deepseek.com](https://platform.deepseek.com), create an account, open the API section, and generate a key for `DEEPSEEK_API_KEY`.

2. Create a Telegram bot and get the bot token.
   Open Telegram, message `@BotFather`, run `/newbot`, follow the prompts, and copy the bot token into `TELEGRAM_BOT_TOKEN`.

3. Get your Telegram chat ID.
   Start a chat with your bot, send it a message, then open:
   `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   Find the `chat` object in the JSON response and copy its `id` into `TELEGRAM_CHAT_ID`.

4. Install dependencies.

   ```bash
   pnpm install
   ```

5. Install Playwright Chromium.

   ```bash
   npx playwright install chromium
   ```

6. Create your environment file.

   ```bash
   touch .env
   ```

   Fill in all required values before running the agent.

7. Start Hermes Agent.

   ```bash
   pnpm start
   ```

## Runtime behavior

- Hermes runs immediately on startup and then follows the configured schedule.
- Founder records are stored in `data/hermes.db`.
- Logs are written to `logs/hermes-agent.log` and `logs/hermes-error.log`.
- If Telegram delivery fails, founders remain unsent in SQLite and are retried on later runs.
- The runtime window persists across process restarts until Hermes completes its configured max runtime.
- Leads must be tech/product related, recent as of February 25, 2026 or from a current 2026 cohort, and have a founder LinkedIn or X/Twitter profile before they are sent.
- Set `DRY_RUN=true` to scrape up to 3 structured leads, enrich them, send exactly one founder message, print spend, and exit without starting cron.
- Dry runs are zero-credit by default: `DRY_RUN_USE_LLM=false` skips the DeepSeek startup ping and skips raw social/news parsing.
- Set `DRY_RUN_USE_LLM=true` only when you want a paid smoke test of raw candidate parsing.
- Use `LLM_PARSE_MAX_PER_RUN` to cap paid raw-candidate parsing attempts per scheduled run. The default is `0`, so paid raw parsing is opt-in.

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

Inspect recent founders:

```bash
pnpm check
```

Inspect API spend:

```bash
pnpm spend
```
