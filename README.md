# Weather EV Monitor

Lean Vercel endpoint for monitoring Hong Kong HKO temperature Polymarket markets.

It sends Telegram alerts when estimated edge is at least `10%`. It can optionally auto-buy one edge signal, and it can separately auto-sell manually selected positions from explicit sell rules.

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
9. If `bet` is `BUY_YES` or `BUY_NO`, send the actionable edge message to the optional second Telegram chat.
10. Buy once for that `date + event + side` only when `AUTO_BUY_ENABLED=true`.
11. Read optional sell rules and sell matching existing positions only when `AUTO_SELL_ENABLED=true`.

## Checking Logic

The endpoint is read-only:

```text
GET /api/check?secret=YOUR_CRON_SECRET
```

Default target date:

- `00:00-15:59 HKT`: monitor today's Polymarket event using the cached HKO forecast saved from the previous day.
- `16:00-23:59 HKT`: monitor tomorrow's Polymarket event using the latest live HKO forecast and save that forecast to Blob.
- `date=YYYY-MM-DD`: override the target date and skip cache saving.
- `dryRun=1`: return the JSON result without sending Telegram.

Market matching:

- First try the exact temperature market, for example `30°C`.
- If no exact market exists, try the nearest supported bucket that contains the HKO forecast, for example `31°C or higher`.
- If no matching market or usable baseline exists, the endpoint returns `bet: "NONE"` with a `reason`.

## Buy Rules

Auto-buy is separate from auto-sell.

Live buying only runs when:

```text
AUTO_BUY_ENABLED=true
```

Buy criteria:

- Only consider `BUY_YES` or `BUY_NO` when edge is at least `EDGE_THRESHOLD`, currently `0.10` unless changed in Vercel.
- Only send actionable buy alerts when the selected Yes/No price is between `MIN_ACTION_PRICE` and `MAX_ACTION_PRICE`, default `0.25` to `0.85`.
- Check spread, liquidity, and market question before placing any manual order.
- For bucket markets such as `31°C or higher`, make sure the baseline source is `monthly_bucket_baseline` or `all_months_bucket_baseline`, not `bucket_baseline_unavailable`.

Buy records live in Vercel Blob:

```text
trade-rules/buy-records.json
```

Order size uses quarter Kelly on a `$10` bankroll, with a `$1` minimum notional guard.

The duplicate key is `date|eventSlug|BUY_YES/BUY_NO`, so repeated cron calls will not buy the same signal twice. Auto-buy does not create any sell rule.

## Auto-Sell

Auto-sell is controlled only by the sell list. Use it for half-manual mode: you buy manually or via auto-buy, then the bot sells only positions that you explicitly add to the sell rules.

Live selling only runs when:

```text
AUTO_SELL_ENABLED=true
```

Rules live in Vercel Blob:

```text
trade-rules/sell-rules.json
```

Example:

```json
{
  "rules": [
    {
      "id": "may-14-29c-no-exit",
      "enabled": true,
      "executed": false,
      "eventSlug": "highest-temperature-in-hong-kong-on-may-14-2026",
      "matchQuestionIncludes": "29°C",
      "outcome": "No",
      "sellAtOrAbove": 0.42,
      "sellAll": true
    }
  ]
}
```

Update or read rules:

```text
GET /api/rules?secret=YOUR_CRON_SECRET
POST /api/rules?secret=YOUR_CRON_SECRET
```

`dryRun=1` on `/api/check` evaluates sell rules but never places orders.

## Telegram

Primary check messages use:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Optional actionable edge messages use:

```text
ACTION_TELEGRAM_BOT_TOKEN=
ACTION_TELEGRAM_CHAT_ID=
```

Set `ACTION_TELEGRAM_CHAT_ID=8682734076` if the action bot should message the same private chat shown by Telegram `getUpdates`.

Test the action channel after deployment:

```text
GET /api/check?secret=YOUR_CRON_SECRET&testAction=1
```

## Environment Variables

Set these in Vercel:

```text
CRON_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=8682734076
ACTION_TELEGRAM_BOT_TOKEN=
ACTION_TELEGRAM_CHAT_ID=8682734076
EDGE_THRESHOLD=0.10
MIN_ACTION_PRICE=0.25
MAX_ACTION_PRICE=0.85
BLOB_READ_WRITE_TOKEN=
AUTO_SELL_ENABLED=false
AUTO_BUY_ENABLED=false
POLYMARKET_PRIVATE_KEY=
POLYMARKET_FUNDER_ADDRESS=
POLYMARKET_SIGNATURE_TYPE=3
POLYMARKET_USER_ADDRESS=
```

Do not commit real Telegram tokens.
If a Telegram token was pasted into chat or logs, rotate it in BotFather before using it in production.
Do not commit any wallet private key. Put trading keys only in Vercel environment variables.

`BLOB_READ_WRITE_TOKEN` is created automatically when you connect Vercel Blob storage to the project.

## Deploy To Vercel

If this folder is inside the `weatherdata` repo, set Vercel Root Directory to:

```text
outputProgram
```

The production function region is configured as Hong Kong:

```text
hkg1
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
