import { readFileSync } from "node:fs";
import { list, put } from "@vercel/blob";

const baseline = JSON.parse(
  readFileSync(new URL("../monthly_exact_baseline.json", import.meta.url), "utf8")
);
const bucketBaseline = JSON.parse(
  readFileSync(new URL("../monthly_bucket_baseline.json", import.meta.url), "utf8")
);

const HKO_URL = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=fnd&lang=en";
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";
const HKO_CACHE_PATH = "hko-cache/latest.json";
const APP_VERSION = "2026-05-13-monitor-v1";

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function getQuery(req) {
  const url = new URL(req.url, "http://localhost");
  return url.searchParams;
}

function isAuthorized(req, query) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  return query.get("secret") === expected || bearer === expected;
}

function tomorrowHkt() {
  const hkt = nowHkt();
  hkt.setDate(hkt.getDate() + 1);
  return formatDate(hkt);
}

function nowHkt() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }));
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateTimeHkt(date) {
  const hkt = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }));
  const hour = String(hkt.getHours()).padStart(2, "0");
  const minute = String(hkt.getMinutes()).padStart(2, "0");
  const second = String(hkt.getSeconds()).padStart(2, "0");
  return `${formatDate(hkt)}T${hour}:${minute}:${second}+08:00`;
}

function yyyymmdd(dateText) {
  return dateText.replaceAll("-", "");
}

function eventSlug(dateText) {
  const [year, month, day] = dateText.split("-").map(Number);
  return `highest-temperature-in-hong-kong-on-${MONTH_NAMES[month - 1]}-${day}-${year}`;
}

function questionDateText(dateText) {
  const [, month, day] = dateText.split("-").map(Number);
  const monthName = MONTH_NAMES[month - 1];
  return `${monthName[0].toUpperCase()}${monthName.slice(1)} ${day}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "user-agent": "weather-ev-monitor/1.0",
      accept: "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

function findForecast(hko, dateText) {
  const target = yyyymmdd(dateText);
  return hko.weatherForecast?.find((item) => item.forecastDate === target);
}

function forecastCachePayload(dateText, hko, forecast) {
  return {
    activeTargetDate: dateText,
    forecastMax: Number(forecast.forecastMaxtemp?.value),
    forecastMin: Number(forecast.forecastMintemp?.value),
    forecastWeather: forecast.forecastWeather || "",
    rainProbability: forecast.PSR || "",
    hkoUpdateTime: hko.updateTime || "",
    cachedAt: new Date().toISOString(),
    source: "hko_fnd_api"
  };
}

async function saveForecastCache(payload) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return { saved: false, reason: "blob_token_missing" };
  }
  const blob = await put(HKO_CACHE_PATH, JSON.stringify(payload, null, 2), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true
  });
  return { saved: true, url: blob.url };
}

async function findBlob(path) {
  const result = await list({ prefix: path, limit: 100 });
  const matches = result.blobs.filter((item) => item.pathname === path);
  matches.sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0));
  return matches[0] || null;
}

async function readBlobJson(path) {
  const blob = await findBlob(path);
  if (!blob) return null;

  const cacheBustedUrl = `${blob.url}${blob.url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  const response = await fetch(cacheBustedUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Blob read failed for ${path}: HTTP ${response.status}`);
  }
  return response.json();
}

async function readForecastCache() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Missing BLOB_READ_WRITE_TOKEN");
  }
  const cached = await readBlobJson(HKO_CACHE_PATH);
  if (!cached) {
    throw new Error("Forecast cache not found");
  }
  return cached;
}

async function getForecastForCheck(queryDate) {
  const hkt = nowHkt();
  const currentHour = hkt.getHours();
  const today = formatDate(hkt);
  const shouldUseCache = !queryDate && currentHour < 16;

  if (shouldUseCache) {
    try {
      const cached = await readForecastCache();
      if (cached.activeTargetDate !== today) {
        throw new Error(`Cached forecast is stale: ${cached.activeTargetDate}, expected ${today}`);
      }
      return {
        date: cached.activeTargetDate,
        forecastMax: Number(cached.forecastMax),
        forecastSource: "blob_cache",
        hkoUpdateTime: cached.hkoUpdateTime,
        cache: { used: true, saved: false }
      };
    } catch (error) {
      const fallback = await getLiveForecast(today, { saveCache: false });
      return {
        ...fallback,
        forecastSource: "hko_live_cache_fallback",
        cache: {
          ...fallback.cache,
          used: false,
          fallbackReason: error.message
        }
      };
    }
  }

  const date = queryDate || tomorrowHkt();
  return getLiveForecast(date, { saveCache: !queryDate });
}

async function getLiveForecast(date, { saveCache = false } = {}) {
  const hko = await fetchJson(HKO_URL);
  const forecast = findForecast(hko, date);
  if (!forecast) {
    return { error: "hko_forecast_not_found", date };
  }

  const cachePayload = forecastCachePayload(date, hko, forecast);
  const cache = saveCache
    ? await saveForecastCache(cachePayload)
    : { saved: false, reason: "cache_save_disabled" };
  return {
    date,
    forecastMax: cachePayload.forecastMax,
    forecastSource: "hko_live",
    hkoUpdateTime: hko.updateTime || "",
    cache: { used: false, ...cache }
  };
}

function findExactMarket(event, forecastMax, dateText) {
  const dateLabel = questionDateText(dateText);
  const exact = new RegExp(`be\\s+${forecastMax}°?C\\s+on\\s+${dateLabel}\\?`, "i");
  return event.markets?.find((market) => exact.test(market.question || ""));
}

function parseBucketMarket(market, dateText) {
  const dateLabel = questionDateText(dateText);
  const pattern = new RegExp(
    `be\\s+(\\d+)°?C\\s+or\\s+(higher|below)\\s+on\\s+${dateLabel}\\?`,
    "i"
  );
  const match = pattern.exec(market.question || "");
  if (!match) return null;
  return {
    market,
    threshold: Number(match[1]),
    direction: match[2].toLowerCase() === "higher" ? "above" : "below"
  };
}

function findBucketMarket(event, forecastMax, dateText) {
  const candidates = (event.markets || [])
    .map((market) => parseBucketMarket(market, dateText))
    .filter(Boolean)
    .filter((bucket) => (
      bucket.direction === "above"
        ? forecastMax >= bucket.threshold
        : forecastMax <= bucket.threshold
    ));

  candidates.sort((a, b) => Math.abs(forecastMax - a.threshold) - Math.abs(forecastMax - b.threshold));
  return candidates[0] || null;
}

function bucketMarketLabel(bucket) {
  return bucket.direction === "above"
    ? `${bucket.threshold}C_OR_HIGHER`
    : `${bucket.threshold}C_OR_BELOW`;
}

function getBucketBaseline(month, direction, threshold) {
  const minSampleCount = Number(process.env.MIN_BUCKET_SAMPLE_COUNT || "20");
  const thresholdKey = String(threshold);
  const monthly = bucketBaseline.months?.[month]?.[direction]?.[thresholdKey];
  if (monthly?.sample_count >= minSampleCount) {
    return { ...monthly, source: "monthly_bucket_baseline" };
  }

  const fallback = bucketBaseline.fallback_all_months?.[direction]?.[thresholdKey];
  if (fallback?.sample_count >= minSampleCount) {
    return {
      ...fallback,
      source: "all_months_bucket_baseline",
      monthly_sample_count: monthly?.sample_count || 0
    };
  }

  return {
    source: "bucket_baseline_unavailable",
    monthly_sample_count: monthly?.sample_count || 0,
    fallback_sample_count: fallback?.sample_count || 0,
    min_sample_count: minSampleCount
  };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  return JSON.parse(value || "[]");
}

function getOutcomeTokenIds(market) {
  const outcomes = parseJsonArray(market.outcomes);
  const tokenIds = parseJsonArray(market.clobTokenIds);
  const yesIndex = outcomes.findIndex((outcome) => String(outcome).toLowerCase() === "yes");
  const noIndex = outcomes.findIndex((outcome) => String(outcome).toLowerCase() === "no");

  if (yesIndex === -1 || noIndex === -1 || !tokenIds[yesIndex] || !tokenIds[noIndex]) {
    return null;
  }
  return {
    yesTokenId: tokenIds[yesIndex],
    noTokenId: tokenIds[noIndex]
  };
}

async function buyPrice(tokenId) {
  // Polymarket CLOB uses side=SELL to return the ask, i.e. the price paid to buy this token.
  const url = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=SELL`;
  const data = await fetchJson(url);
  const price = Number(data.price);
  if (!Number.isFinite(price)) {
    throw new Error("buy_price_unavailable");
  }
  return price;
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function sendTelegramTo({ token, chatId, message }) {
  if (!token || !chatId) {
    throw new Error("Missing Telegram token or chat ID");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram HTTP ${response.status}: ${body}`);
  }
}

async function sendTelegram(message) {
  return sendTelegramTo({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    message
  });
}

async function sendActionTelegram(message) {
  return sendTelegramTo({
    token: process.env.ACTION_TELEGRAM_BOT_TOKEN,
    chatId: process.env.ACTION_TELEGRAM_CHAT_ID,
    message
  });
}

function telegramMessage(result) {
  const hasEdge = result.bet !== "NONE";
  const edge = result.bet === "BUY_YES" ? result.yesEdge : result.noEdge;
  const price = result.bet === "BUY_YES" ? result.yesPrice : result.noPrice;
  const model = result.bet === "BUY_YES" ? result.yesProb : result.noProb;
  const value = (item) => item ?? "N/A";

  const lines = [
    hasEdge ? "Weather edge found" : "Weather check",
    "",
    `Date: ${value(result.date)}`,
    `HKO prediction: highest temperature ${value(result.forecastMax)}°C`,
    `Market question: ${value(result.marketQuestion)}`,
    `Market type: ${value(result.marketType)}`,
    `Yes price: ${value(result.yesPrice)}`,
    `No price: ${value(result.noPrice)}`,
    `Model Yes: ${value(result.yesProb)}`,
    `Model No: ${value(result.noProb)}`,
    `Yes edge: ${value(result.yesEdge)}`,
    `No edge: ${value(result.noEdge)}`,
    `Bet: ${hasEdge ? result.bet.replace("_", " ") : "NONE"}`
  ];

  if (result.reason) {
    lines.push(`Reason: ${result.reason}`);
  }

  if (hasEdge) {
    lines.push(
      `Market price: ${price}`,
      `Model probability: ${model}`,
      `Edge: ${edge}`
    );
  }

  lines.push(
    "",
    `Market: https://polymarket.com/event/${result.eventSlug}`
  );

  return lines.join("\n");
}

function actionTelegramMessage(result) {
  const side = result.bet.replace("_", " ");
  const edge = result.bet === "BUY_YES" ? result.yesEdge : result.noEdge;
  const price = result.bet === "BUY_YES" ? result.yesPrice : result.noPrice;
  const probability = result.bet === "BUY_YES" ? result.yesProb : result.noProb;

  return [
    "Actionable weather edge",
    "",
    `Suggested action: ${side}`,
    `Date: ${result.date}`,
    `HKO prediction: highest temperature ${result.forecastMax}°C`,
    `Market: ${result.marketQuestion}`,
    `Price: ${price}`,
    `Model probability: ${probability}`,
    `Edge: ${edge}`,
    "",
    `Link: https://polymarket.com/event/${result.eventSlug}`
  ].join("\n");
}

async function sendCheckResult(res, result, dryRun) {
  if (!dryRun) {
    try {
      await sendTelegram(telegramMessage(result));
      result.alert = true;
    } catch (error) {
      result.alert = false;
      result.telegramError = error.message;
    }
    if (result.bet !== "NONE") {
      try {
        await sendActionTelegram(actionTelegramMessage(result));
        result.actionAlert = true;
      } catch (error) {
        result.actionAlert = false;
        result.actionTelegramError = error.message;
      }
    }
  }
  return json(res, 200, result);
}

export default async function handler(req, res) {
  const query = getQuery(req);
  if (!isAuthorized(req, query)) {
    return json(res, 401, { error: "unauthorized" });
  }

  if (query.get("testAction") === "1") {
    try {
      await sendActionTelegram([
        "Action Telegram test",
        "",
        `Sent from Vercel at ${formatDateTimeHkt(new Date())}`
      ].join("\n"));
      return json(res, 200, { actionAlert: true });
    } catch (error) {
      return json(res, 500, {
        actionAlert: false,
        actionTelegramError: error.message
      });
    }
  }

  const queryDate = query.get("date");
  const dryRun = query.get("dryRun") === "1";
  const edgeThreshold = Number(process.env.EDGE_THRESHOLD || "0.10");

  try {
    const forecastInfo = await getForecastForCheck(queryDate);
    if (forecastInfo.error) {
      return json(res, 404, forecastInfo);
    }

    const { date, forecastMax, forecastSource, hkoUpdateTime, cache } = forecastInfo;
    const month = date.slice(5, 7);
    const monthBaseline = baseline.months?.[month];
    if (!monthBaseline) {
      return json(res, 404, { error: "baseline_month_not_found", month });
    }

    const slug = eventSlug(date);
    const event = await fetchJson(`${GAMMA_BASE}/events/slug/${slug}`);
    let market = findExactMarket(event, forecastMax, date);
    let marketType = "exact";
    let baselineInfo = {
      source: "monthly_exact_baseline",
      sample_count: monthBaseline.sample_count
    };
    let yesProb = Number(monthBaseline.yes_probability);
    let noProb = Number(monthBaseline.no_probability);

    if (!market) {
      const bucket = findBucketMarket(event, forecastMax, date);
      if (!bucket) {
        return sendCheckResult(res, {
          version: APP_VERSION,
          checkedAtHkt: formatDateTimeHkt(new Date()),
          date,
          forecastMax,
          forecastSource,
          hkoUpdateTime,
          cache,
          bet: "NONE",
          alert: false,
          eventSlug: slug,
          reason: "exact_or_supported_bucket_market_not_found"
        }, dryRun);
      }

      baselineInfo = getBucketBaseline(month, bucket.direction, bucket.threshold);
      if (baselineInfo.source === "bucket_baseline_unavailable") {
        return sendCheckResult(res, {
          version: APP_VERSION,
          checkedAtHkt: formatDateTimeHkt(new Date()),
          date,
          forecastMax,
          forecastSource,
          hkoUpdateTime,
          cache,
          bet: "NONE",
          alert: false,
          eventSlug: slug,
          marketQuestion: bucket.market.question,
          marketType: bucketMarketLabel(bucket),
          baseline: baselineInfo,
          reason: "bucket_baseline_sample_too_small"
        }, dryRun);
      }

      market = bucket.market;
      marketType = bucketMarketLabel(bucket);
      yesProb = Number(baselineInfo.yes_probability);
      noProb = Number(baselineInfo.no_probability);
    }

    const tokenIds = getOutcomeTokenIds(market);
    if (!tokenIds) {
      return sendCheckResult(res, {
        version: APP_VERSION,
        checkedAtHkt: formatDateTimeHkt(new Date()),
        date,
        forecastMax,
        forecastSource,
        hkoUpdateTime,
        cache,
        bet: "NONE",
        alert: false,
        eventSlug: slug,
        marketQuestion: market.question,
        marketType,
        baseline: baselineInfo,
        reason: "clob_token_ids_missing"
      }, dryRun);
    }

    const [yesPrice, noPrice] = await Promise.all([
      buyPrice(tokenIds.yesTokenId),
      buyPrice(tokenIds.noTokenId)
    ]);

    const yesEdge = round6(yesProb - yesPrice);
    const noEdge = round6(noProb - noPrice);

    let bet = "NONE";
    if (yesEdge >= edgeThreshold && yesEdge >= noEdge) {
      bet = "BUY_YES";
    } else if (noEdge >= edgeThreshold) {
      bet = "BUY_NO";
    }

    const result = {
      version: APP_VERSION,
      checkedAtHkt: formatDateTimeHkt(new Date()),
      date,
      forecastMax,
      yesPrice,
      noPrice,
      yesProb,
      noProb,
      yesEdge,
      noEdge,
      bet,
      alert: false,
      eventSlug: slug,
      marketQuestion: market.question,
      marketType,
      baseline: baselineInfo,
      forecastSource,
      hkoUpdateTime,
      cache
    };

    return sendCheckResult(res, result, dryRun);
  } catch (error) {
    return json(res, 500, {
      error: "check_failed",
      message: error.message
    });
  }
}
