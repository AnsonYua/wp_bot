import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { list, put } from "@vercel/blob";
import { Chain, ClobClient, OrderType, Side } from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";

const baseline = JSON.parse(
  readFileSync(new URL("../monthly_exact_baseline.json", import.meta.url), "utf8")
);
const bucketBaseline = JSON.parse(
  readFileSync(new URL("../monthly_bucket_baseline.json", import.meta.url), "utf8")
);

const HKO_URL = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=fnd&lang=en";
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";
const DATA_API_BASE = "https://data-api.polymarket.com";
const HKO_CACHE_PATH = "hko-cache/latest.json";
const SELL_RULES_PATH = "trade-rules/sell-rules.json";
const PENDING_RULE_TIMEOUT_MS = 5 * 60 * 1000;
const APP_VERSION = "2026-05-13-auto-sell-v1";

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

async function readForecastCache() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Missing BLOB_READ_WRITE_TOKEN");
  }
  const result = await list({ prefix: HKO_CACHE_PATH, limit: 1 });
  const blob = result.blobs.find((item) => item.pathname === HKO_CACHE_PATH);
  if (!blob) {
    throw new Error("Forecast cache not found");
  }
  const cacheBustedUrl = `${blob.url}${blob.url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  const response = await fetch(cacheBustedUrl, { cache: "no-store" });
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
  return Number(data.price);
}

async function sellPrice(tokenId) {
  // Polymarket CLOB uses side=BUY to return the bid, i.e. the price received to sell this token.
  const url = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`;
  const data = await fetchJson(url);
  return Number(data.price);
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHktDateTime(value) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function isPendingStale(rule) {
  if (!rule.pending) return false;
  const pendingAt = parseHktDateTime(rule.pendingAt);
  if (!pendingAt) return true;
  return Date.now() - pendingAt.getTime() > PENDING_RULE_TIMEOUT_MS;
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

async function readSellRules() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return { rules: [], available: false, reason: "blob_token_missing" };
  }

  const result = await list({ prefix: SELL_RULES_PATH, limit: 1 });
  const blob = result.blobs.find((item) => item.pathname === SELL_RULES_PATH);
  if (!blob) {
    return { rules: [], available: true, missing: true };
  }

  const cacheBustedUrl = `${blob.url}${blob.url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  const response = await fetch(cacheBustedUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Sell rules not found: HTTP ${response.status}`);
  }
  return { ...(await response.json()), available: true };
}

async function writeSellRules(payload) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Missing BLOB_READ_WRITE_TOKEN");
  }
  await put(SELL_RULES_PATH, JSON.stringify(payload, null, 2), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

async function markRulePending(ruleId) {
  if (!ruleId) return null;

  const latest = await readSellRules();
  const rules = Array.isArray(latest.rules) ? latest.rules : [];
  const rule = rules.find((item) => item.id === ruleId);
  if (!rule || !rule.enabled || rule.executed || (rule.pending && !isPendingStale(rule))) {
    return null;
  }

  const pendingId = randomUUID();
  rule.pending = true;
  rule.pendingId = pendingId;
  rule.pendingAt = formatDateTimeHkt(new Date());
  await writeSellRules({ ...latest, rules });

  // Vercel Blob has no compare-and-set write. Re-read after a short delay so
  // overlapping scheduler calls do not both proceed after racing the same rule.
  await sleep(750);
  const verify = await readSellRules();
  const verifiedRule = (verify.rules || []).find((item) => item.id === ruleId);
  if (!verifiedRule || verifiedRule.executed || verifiedRule.pendingId !== pendingId) {
    return null;
  }

  return pendingId;
}

async function updateSellRule(ruleId, updates) {
  const latest = await readSellRules();
  const rules = Array.isArray(latest.rules) ? latest.rules : [];
  const rule = rules.find((item) => item.id === ruleId);
  if (!rule) return false;

  Object.assign(rule, updates);
  await writeSellRules({ ...latest, rules });
  return true;
}

function ruleMatchesMarket(market, rule) {
  const question = String(market.question || "").toLowerCase();
  const needle = String(rule.matchQuestionIncludes || "").toLowerCase();
  return needle && question.includes(needle);
}

function getTickSize(market) {
  return String(market.orderPriceMinTickSize || market.tickSize || "0.01");
}

function getPositionSize(positions, tokenId) {
  const position = positions.find((item) => {
    const ids = [item.asset, item.assetId, item.tokenId, item.token_id, item.clobTokenId];
    return ids.some((id) => String(id) === String(tokenId));
  });
  if (!position) return 0;
  return Number(position.size ?? position.balance ?? position.quantity ?? position.shares ?? position.amount ?? 0);
}

async function getPositionSizeForToken(tokenId) {
  const user = process.env.POLYMARKET_USER_ADDRESS;
  if (!user) {
    throw new Error("Missing POLYMARKET_USER_ADDRESS");
  }

  const positions = await fetchJson(
    `${DATA_API_BASE}/positions?user=${encodeURIComponent(user)}`
  );
  return getPositionSize(Array.isArray(positions) ? positions : [], tokenId);
}

function createPolymarketSigner() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("Missing POLYMARKET_PRIVATE_KEY");
  }

  const wallet = new Wallet(privateKey);
  return {
    getAddress: () => wallet.getAddress(),
    _signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value)
  };
}

async function placeSellOrder({ tokenId, price, size, market }) {
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS;
  const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE || "3");
  if (!funder) {
    throw new Error("Missing POLYMARKET_FUNDER_ADDRESS");
  }

  const signer = createPolymarketSigner();
  const clientOptions = {
    host: CLOB_BASE,
    chain: Chain.POLYGON,
    signer,
    signatureType,
    funderAddress: funder
  };
  const authClient = new ClobClient(clientOptions);
  const creds = await authClient.createOrDeriveApiKey();
  const clobClient = new ClobClient({ ...clientOptions, creds });

  return clobClient.createAndPostOrder(
    {
      tokenID: String(tokenId),
      price: Number(price),
      side: Side.SELL,
      size: Number(size)
    },
    {
      tickSize: getTickSize(market),
      negRisk: Boolean(market.negRisk)
    },
    OrderType.GTC
  );
}

function tradeMessage(action) {
  const title = action.status === "sold"
    ? "Auto-sell executed"
    : action.status === "failed"
      ? "Auto-sell failed"
      : "Auto-sell check";
  const lines = [
    title,
    "",
    `Rule: ${action.ruleId}`,
    `Market: ${action.marketQuestion || "N/A"}`,
    `Outcome: ${action.outcome || "No"}`,
    `Target price: ${action.targetPrice ?? "N/A"}`,
    `Current sell price: ${action.currentSellPrice ?? "N/A"}`,
    `Shares: ${action.shares ?? "N/A"}`
  ];

  if (action.orderId) lines.push(`Order ID: ${action.orderId}`);
  if (action.reason) lines.push(`Reason: ${action.reason}`);
  if (action.error) lines.push(`Error: ${action.error}`);
  if (action.eventSlug) {
    lines.push("", `Market: https://polymarket.com/event/${action.eventSlug}`);
  }

  return lines.join("\n");
}

async function runAutoSellRules({ dryRun }) {
  const rulesPayload = await readSellRules();
  const rules = Array.isArray(rulesPayload.rules) ? rulesPayload.rules : [];
  const actions = [];
  const liveTrading = process.env.AUTO_TRADE_ENABLED === "true";

  for (const rule of rules) {
    if (!rule.enabled || rule.executed || (rule.pending && !isPendingStale(rule))) continue;

    const action = {
      ruleId: rule.id || "unnamed-rule",
      eventSlug: rule.eventSlug,
      outcome: rule.outcome || "No",
      targetPrice: Number(rule.sellAtOrAbove)
    };

    try {
      if (String(rule.outcome || "No").toLowerCase() !== "no") {
        actions.push({ ...action, status: "skipped", reason: "only_no_outcome_supported" });
        continue;
      }
      if (!rule.eventSlug || !rule.matchQuestionIncludes || !Number.isFinite(action.targetPrice)) {
        actions.push({ ...action, status: "skipped", reason: "invalid_rule" });
        continue;
      }
      if (!rule.id) {
        actions.push({ ...action, status: "skipped", reason: "rule_id_missing" });
        continue;
      }

      const event = await fetchJson(`${GAMMA_BASE}/events/slug/${rule.eventSlug}`);
      const matchingMarkets = (event.markets || []).filter((item) => ruleMatchesMarket(item, rule));
      if (matchingMarkets.length === 0) {
        actions.push({ ...action, status: "skipped", reason: "market_not_found" });
        continue;
      }
      if (matchingMarkets.length > 1) {
        actions.push({ ...action, status: "skipped", reason: "multiple_markets_matched" });
        continue;
      }

      const market = matchingMarkets[0];
      action.marketQuestion = market.question;
      const tokenIds = getOutcomeTokenIds(market);
      if (!tokenIds?.noTokenId) {
        actions.push({ ...action, status: "skipped", reason: "no_token_id_missing" });
        continue;
      }

      const shares = getPositionSizeForToken(tokenIds.noTokenId);
      const [currentSellPrice, positionSize] = await Promise.all([
        sellPrice(tokenIds.noTokenId),
        shares
      ]);
      action.currentSellPrice = currentSellPrice;
      action.shares = positionSize;

      if (!Number.isFinite(currentSellPrice)) {
        actions.push({ ...action, status: "skipped", reason: "sell_price_unavailable" });
        continue;
      }
      if (!Number.isFinite(positionSize) || positionSize <= 0) {
        actions.push({ ...action, status: "skipped", reason: "no_position" });
        continue;
      }
      if (currentSellPrice < action.targetPrice) {
        actions.push({ ...action, status: "skipped", reason: "target_not_reached" });
        continue;
      }
      if (dryRun) {
        actions.push({ ...action, status: "would_sell", reason: "dry_run" });
        continue;
      }
      if (!liveTrading) {
        actions.push({ ...action, status: "would_sell", reason: "auto_trade_disabled" });
        continue;
      }

      const pendingId = await markRulePending(rule.id);
      if (!pendingId) {
        actions.push({ ...action, status: "skipped", reason: "rule_already_pending_or_executed" });
        continue;
      }

      const order = await placeSellOrder({
        tokenId: tokenIds.noTokenId,
        price: action.targetPrice,
        size: positionSize,
        market
      });
      const orderId = order?.orderID || order?.orderId || order?.id;
      if (order?.success !== true && !orderId) {
        throw new Error(order?.errorMsg || order?.error || "Polymarket order was not successful");
      }

      const now = formatDateTimeHkt(new Date());
      await updateSellRule(rule.id, {
        executed: true,
        pending: false,
        pendingId,
        executedAt: now,
        orderId,
        orderStatus: order.status || "",
        soldOutcome: "No",
        soldShares: positionSize,
        targetPrice: action.targetPrice,
        observedSellPrice: currentSellPrice
      });

      const soldAction = {
        ...action,
        status: "sold",
        orderId,
        orderStatus: order.status || ""
      };
      actions.push(soldAction);
      try {
        await sendTelegram(tradeMessage(soldAction));
      } catch (telegramError) {
        soldAction.telegramError = telegramError.message;
      }
    } catch (error) {
      const failedAction = { ...action, status: "failed", error: error.message };
      actions.push(failedAction);
      if (!dryRun && liveTrading && rule.id) {
        await updateSellRule(rule.id, {
          pending: false,
          pendingId: "",
          lastError: error.message,
          lastErrorAt: formatDateTimeHkt(new Date())
        });
      }
      if (!dryRun) {
        await sendTelegram(tradeMessage(failedAction));
      }
    }
  }

  return {
    enabled: liveTrading,
    dryRun,
    rulesPath: SELL_RULES_PATH,
    rulesCount: rules.length,
    actions
  };
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

async function sendCheckResult(res, result, dryRun) {
  if (!dryRun) {
    try {
      await sendTelegram(telegramMessage(result));
      result.alert = true;
    } catch (error) {
      result.alert = false;
      result.telegramError = error.message;
    }
  }
  try {
    result.autoSell = await runAutoSellRules({ dryRun });
  } catch (error) {
    result.autoSell = { error: error.message };
    if (!dryRun) {
      await sendTelegram(`Auto-sell check failed\n\nError: ${error.message}`);
    }
  }
  return json(res, 200, result);
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
