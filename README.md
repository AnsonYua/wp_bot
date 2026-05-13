# Weather EV Monitor

Lean Vercel endpoint for monitoring Hong Kong HKO temperature Polymarket markets.

It sends Telegram alerts when estimated edge is at least `10%`. It does not place orders or require Polymarket private keys.

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
9. Send Telegram with the HKO prediction, market prices, model probabilities, edge, and suggested side.

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

## Order Rules

The code now only suggests trades. It intentionally does not auto-buy or auto-sell.

Use these manual order rules when reading the Telegram message:

- Only consider `BUY_YES` or `BUY_NO` when edge is at least `EDGE_THRESHOLD`, currently `0.10` unless changed in Vercel.
- Avoid buying very cheap or very expensive contracts; the previous execution rule was to only consider prices from `0.25` to `0.85`.
- Check spread, liquidity, and market question before placing any manual order.
- For bucket markets such as `31°C or higher`, make sure the baseline source is `monthly_bucket_baseline` or `all_months_bucket_baseline`, not `bucket_baseline_unavailable`.
- Keep all private keys out of this project. The monitor does not need `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS`, or trading API credentials.

## Environment Variables

Set these in Vercel:

```text
CRON_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=8682734076
EDGE_THRESHOLD=0.10
BLOB_READ_WRITE_TOKEN=
```

Do not commit real Telegram tokens.
Do not commit any wallet private key.

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
