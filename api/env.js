function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body, null, 2));
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

function sortedEnvObject() {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([, value]) => typeof value === "string")
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

export default async function handler(req, res) {
  const query = getQuery(req);
  if (!isAuthorized(req, query)) {
    return json(res, 401, { error: "unauthorized" });
  }

  if (req.method !== "GET") {
    return json(res, 405, {
      error: "method_not_allowed",
      use: "GET /api/env?secret=YOUR_SECRET"
    });
  }

  return json(res, 200, {
    capturedAt: new Date().toISOString(),
    deployment: {
      vercelEnv: process.env.VERCEL_ENV || null,
      vercelRegion: process.env.VERCEL_REGION || null,
      vercelUrl: process.env.VERCEL_URL || null,
      vercelGitCommitSha: process.env.VERCEL_GIT_COMMIT_SHA || null
    },
    env: sortedEnvObject()
  });
}
