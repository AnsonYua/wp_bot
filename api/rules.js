import { list, put } from "@vercel/blob";

const SELL_RULES_PATH = "trade-rules/sell-rules.json";
const SELL_LOG_PATH = "trade-rules/sell-log.json";

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

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function findBlob(path) {
  const result = await list({ prefix: path, limit: 100 });
  const matches = result.blobs.filter((item) => item.pathname === path);
  matches.sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0));
  return matches[0] || null;
}

async function readRules() {
  const blob = await findBlob(SELL_RULES_PATH);
  if (!blob) {
    return { rules: [] };
  }

  const url = `${blob.url}${blob.url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Rules read failed: HTTP ${response.status}`);
  }
  return response.json();
}

async function readBlobJson(path, fallback) {
  const blob = await findBlob(path);
  if (!blob) {
    return fallback;
  }

  const url = `${blob.url}${blob.url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Blob read failed: HTTP ${response.status}`);
  }
  return response.json();
}

async function writeRules(payload) {
  const blob = await put(SELL_RULES_PATH, JSON.stringify(payload, null, 2), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true
  });
  return blob.url;
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== "object") {
    throw new Error("Missing rule object");
  }
  if (!rule.id || !rule.eventSlug || !rule.matchQuestionIncludes) {
    throw new Error("Rule requires id, eventSlug, and matchQuestionIncludes");
  }

  const sellAtOrAbove = Number(rule.sellAtOrAbove);
  if (!Number.isFinite(sellAtOrAbove)) {
    throw new Error("Rule requires numeric sellAtOrAbove");
  }

  return {
    id: String(rule.id),
    enabled: rule.enabled !== false,
    executed: Boolean(rule.executed),
    eventSlug: String(rule.eventSlug),
    matchQuestionIncludes: String(rule.matchQuestionIncludes),
    outcome: "No",
    sellAtOrAbove,
    sellAll: true
  };
}

export default async function handler(req, res) {
  const query = getQuery(req);
  if (!isAuthorized(req, query)) {
    return json(res, 401, { error: "unauthorized" });
  }

  try {
    if (req.method === "GET") {
      if (query.get("log") === "1") {
        return json(res, 200, await readBlobJson(SELL_LOG_PATH, { entries: [] }));
      }
      return json(res, 200, await readRules());
    }

    if (req.method !== "POST") {
      return json(res, 405, { error: "method_not_allowed" });
    }

    const body = await readBody(req);
    let payload;
    if (Array.isArray(body.rules)) {
      payload = { rules: body.rules.map(normalizeRule) };
    } else {
      const current = await readRules();
      const rule = normalizeRule(body.rule || body);
      const rules = Array.isArray(current.rules) ? current.rules : [];
      const existingIndex = rules.findIndex((item) => item.id === rule.id);
      if (existingIndex === -1) {
        rules.push(rule);
      } else {
        rules[existingIndex] = rule;
      }
      payload = { ...current, rules };
    }

    const url = await writeRules(payload);
    return json(res, 200, { saved: true, url, payload });
  } catch (error) {
    return json(res, 400, {
      error: "rules_write_failed",
      message: error.message
    });
  }
}
