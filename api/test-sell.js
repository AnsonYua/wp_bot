import { Chain, ClobClient, OrderType, Side } from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";

const CLOB_BASE = "https://clob.polymarket.com";
const TEST_TOKEN_ID = "82036009961395704955899886648984423477652464068228246839788751747749930086760";
const TEST_SIZE = 0.1;

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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "weather-ev-monitor/1.0",
      accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

async function currentSellPrice(tokenId) {
  const data = await fetchJson(`${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`);
  const price = Number(data.price);
  if (!Number.isFinite(price)) {
    throw new Error("current_sell_price_unavailable");
  }
  return price;
}

function createSigner() {
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

async function placeTestSell(price) {
  const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS;
  if (!funderAddress) {
    throw new Error("Missing POLYMARKET_FUNDER_ADDRESS");
  }

  const signer = createSigner();
  const options = {
    host: CLOB_BASE,
    chain: Chain.POLYGON,
    signer,
    signatureType: Number(process.env.POLYMARKET_SIGNATURE_TYPE || "3"),
    funderAddress
  };
  const authClient = new ClobClient(options);
  const creds = await authClient.createOrDeriveApiKey();
  const client = new ClobClient({ ...options, creds });

  return client.createAndPostOrder(
    {
      tokenID: TEST_TOKEN_ID,
      price,
      side: Side.SELL,
      size: TEST_SIZE
    },
    {
      tickSize: "0.001",
      negRisk: true
    },
    OrderType.GTC
  );
}

export default async function handler(req, res) {
  const query = getQuery(req);
  if (!isAuthorized(req, query)) {
    return json(res, 401, { error: "unauthorized" });
  }

  if (req.method !== "POST") {
    return json(res, 405, {
      error: "method_not_allowed",
      use: "POST /api/test-sell?secret=YOUR_SECRET"
    });
  }

  try {
    const price = await currentSellPrice(TEST_TOKEN_ID);
    const order = await placeTestSell(price);
    const orderId = order?.orderID || order?.orderId || order?.id;
    if (order?.success !== true && !orderId) {
      throw new Error(order?.errorMsg || order?.error || "Polymarket order was not successful");
    }

    return json(res, 200, {
      sold: true,
      tokenId: TEST_TOKEN_ID,
      size: TEST_SIZE,
      price,
      order
    });
  } catch (error) {
    return json(res, 400, {
      sold: false,
      tokenId: TEST_TOKEN_ID,
      size: TEST_SIZE,
      error: error.message
    });
  }
}
