# Weather EV Monitor

Lean Vercel endpoint for monitoring Hong Kong HKO temperature Polymarket markets.

It does not trade. It only sends Telegram alerts when estimated edge is at least `10%`.

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
8. Send Telegram if Yes or No edge is at least `EDGE_THRESHOLD`.

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
