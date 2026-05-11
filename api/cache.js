import { put } from "@vercel/blob";

const HKO_CACHE_PATH = "hko-cache/latest.json";

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

function required(query, name) {
  const value = query.get(name);
  if (!value) {
    throw new Error(`Missing required parameter: ${name}`);
  }
  return value;
}

export default async function handler(req, res) {
  const query = getQuery(req);
  if (!isAuthorized(req, query)) {
    return json(res, 401, { error: "unauthorized" });
  }

  try {
    const payload = {
      activeTargetDate: required(query, "date"),
      forecastMax: Number(required(query, "max")),
      forecastMin: query.get("min") ? Number(query.get("min")) : null,
      forecastWeather: query.get("weather") || "",
      rainProbability: query.get("rain") || "",
      hkoUpdateTime: required(query, "hkoUpdateTime"),
      cachedAt: new Date().toISOString(),
      source: "manual"
    };

    if (!Number.isFinite(payload.forecastMax)) {
      return json(res, 400, { error: "invalid_max" });
    }

    const blob = await put(HKO_CACHE_PATH, JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true
    });

    return json(res, 200, {
      saved: true,
      url: blob.url,
      payload
    });
  } catch (error) {
    return json(res, 400, {
      error: "cache_write_failed",
      message: error.message
    });
  }
}
