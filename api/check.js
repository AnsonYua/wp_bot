import { readFileSync } from "node:fs";
import { list, put } from "@vercel/blob";

const baseline = JSON.parse(
  readFileSync(new URL("../monthly_exact_baseline.json", import.meta.url), "utf8")
);

const HKO_URL = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=fnd&lang=en";
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";
const HKO_CACHE_PATH = "hko-cache/latest.json";

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

async function readForecastCache() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Missing BLOB_READ_WRITE_TOKEN");
  }
  const result = await list({ prefix: HKO_CACHE_PATH, limit: 1 });
  const blob = result.blobs.find((item) => item.pathname === HKO_CACHE_PATH);
  if (!blob) {
    throw new Error("Forecast cache not found");
  }
  const response = await fetch(blob.url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Forecast cache not found: HTTP ${response.status}`);
  }
  return response.json();
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
      const fallback = await getLiveForecast(today);
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
  return getLiveForecast(date);
}

async function getLiveForecast(date) {
  const hko = await fetchJson(HKO_URL);
  const forecast = findForecast(hko, date);
  if (!forecast) {
    return { error: "hko_forecast_not_found", date };
  }

  const cachePayload = forecastCachePayload(date, hko, forecast);
  const cache = await saveForecastCache(cachePayload);
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

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  return JSON.parse(value || "[]");
}

async function buyPrice(tokenId) {
  // Polymarket CLOB uses side=SELL to return the ask, i.e. the price paid to buy this token.
  const url = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=SELL`;
  const data = await fetchJson(url);
  return Number(data.price);
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
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

function telegramMessage(result) {
  const hasEdge = result.bet !== "NONE";
  const edge = result.bet === "BUY_YES" ? result.yesEdge : result.noEdge;
  const price = result.bet === "BUY_YES" ? result.yesPrice : result.noPrice;
  const model = result.bet === "BUY_YES" ? result.yesProb : result.noProb;

  const lines = [
    hasEdge ? "Weather edge found" : "Weather check",
    "",
    `Date: ${result.date}`,
    `HKO prediction: highest temperature ${result.forecastMax}°C`,
    `Yes price: ${result.yesPrice}`,
    `No price: ${result.noPrice}`,
    `Model Yes: ${result.yesProb}`,
    `Model No: ${result.noProb}`,
    `Yes edge: ${result.yesEdge}`,
    `No edge: ${result.noEdge}`,
    `Bet: ${hasEdge ? result.bet.replace("_", " ") : "NONE"}`
  ];

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

export default async function handler(req, res) {
  const query = getQuery(req);
  if (!isAuthorized(req, query)) {
    return json(res, 401, { error: "unauthorized" });
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
    const market = findExactMarket(event, forecastMax, date);
    if (!market) {
      return json(res, 200, {
        date,
        forecastMax,
        forecastSource,
        bet: "NONE",
        alert: false,
        reason: "exact_market_not_found"
      });
    }

    const tokenIds = parseJsonArray(market.clobTokenIds);
    if (tokenIds.length < 2) {
      return json(res, 200, {
        date,
        forecastMax,
        forecastSource,
        bet: "NONE",
        alert: false,
        reason: "clob_token_ids_missing"
      });
    }

    const [yesPrice, noPrice] = await Promise.all([
      buyPrice(tokenIds[0]),
      buyPrice(tokenIds[1])
    ]);

    const yesProb = Number(monthBaseline.yes_probability);
    const noProb = Number(monthBaseline.no_probability);
    const yesEdge = round6(yesProb - yesPrice);
    const noEdge = round6(noProb - noPrice);

    let bet = "NONE";
    let bestEdge = 0;
    if (yesEdge >= edgeThreshold && yesEdge >= noEdge) {
      bet = "BUY_YES";
      bestEdge = yesEdge;
    } else if (noEdge >= edgeThreshold) {
      bet = "BUY_NO";
      bestEdge = noEdge;
    }

    const result = {
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
      forecastSource,
      hkoUpdateTime,
      cache
    };

    if (!dryRun) {
      await sendTelegram(telegramMessage(result));
      result.alert = true;
    }

    return json(res, 200, result);
  } catch (error) {
    return json(res, 500, {
      error: "check_failed",
      message: error.message
    });
  }
}
