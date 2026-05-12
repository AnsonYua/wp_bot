# Weather EV Monitor

Lean Vercel endpoint for monitoring Hong Kong HKO temperature Polymarket markets.

It sends Telegram alerts when estimated edge is at least `10%`. It can also auto-sell an existing `NO` position when a simple Blob rule target is reached.

## Endpoint

```text
GET /api/check?secret=YOUR_CRON_SECRET
```

Optional:

```text
date=YYYY-MM-DD
dryRun=1
```

Example:

```text
/api/check?secret=YOUR_CRON_SECRET&dryRun=1&date=2026-05-12
```

Manual cache overwrite:

```text
GET /api/cache?secret=YOUR_CRON_SECRET&date=2026-05-12&max=30&min=24&hkoUpdateTime=2026-05-11T16%3A30%3A00%2B08%3A00
```

Use this only when you missed the previous-day HKO forecast cache.

## Logic

1. Fetch HKO 9-day forecast.
2. Pick target date:
   - `00:00-15:59 HKT`: use cached forecast for today from Vercel Blob.
   - `16:00-23:59 HKT`: use live HKO forecast for tomorrow and save it to Blob.
3. Read HKO forecast max temperature.
4. Fetch matching Polymarket event.
5. Find exact market matching the HKO forecast temperature.
6. Fetch Yes and No buy prices from Polymarket CLOB.
7. Compare prices with monthly baseline probabilities.
8. Send Telegram with the check result.
9. Read optional auto-sell rules from Vercel Blob and sell existing `NO` positions only when enabled.

## Auto-Sell Rules

Rules live in one Vercel Blob file:

```text
trade-rules/sell-rules.json
```

Example:

```json
{
  "rules": [
    {
      "id": "may-14-28c-no-exit",
      "enabled": true,
      "executed": false,
      "eventSlug": "highest-temperature-in-hong-kong-on-may-14-2026",
      "matchQuestionIncludes": "Will the highest temperature in Hong Kong be 28°C on May 14?",
      "outcome": "No",
      "sellAtOrAbove": 0.75,
      "sellAll": true
    }
  ]
}
```

Keep `matchQuestionIncludes` specific. If it matches multiple markets, the bot skips the rule instead of guessing.

Live orders only run when:

```text
AUTO_TRADE_ENABLED=true
```

`dryRun=1` never places orders.

## Environment Variables

Set these in Vercel:

```text
CRON_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=8682734076
EDGE_THRESHOLD=0.10
BLOB_READ_WRITE_TOKEN=
AUTO_TRADE_ENABLED=false
POLYMARKET_PRIVATE_KEY=
POLYMARKET_FUNDER_ADDRESS=
POLYMARKET_SIGNATURE_TYPE=3
POLYMARKET_USER_ADDRESS=
```

Do not commit real Telegram tokens.
Do not commit your Polymarket private key.

`BLOB_READ_WRITE_TOKEN` is created automatically when you connect Vercel Blob storage to the project.

## Deploy To Vercel

If this folder is inside the `weatherdata` repo, set Vercel Root Directory to:

```text
outputProgram
```

Then deploy normally.

## Scheduler

Call this every 5 minutes:

```text
https://YOUR_VERCEL_DOMAIN/api/check?secret=YOUR_CRON_SECRET
```

Use `dryRun=1` for testing:

```text
https://YOUR_VERCEL_DOMAIN/api/check?secret=YOUR_CRON_SECRET&dryRun=1
```
