// ============================================================
// OPTIQ LITE - NSE PROXY v2
// Better cookie handling + multiple endpoint fallbacks
// Deployed on Render.com free tier
// ============================================================

const http  = require("http");
const https = require("https");
const zlib  = require("zlib");

const PORT = process.env.PORT || 4000;

// ── Session store ────────────────────────────────────────────
let session = { cookies: "", ua: "", lastRefresh: 0 };

// Rotate user agents to avoid detection
const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
];
const randUA = () => UAS[Math.floor(Math.random() * UAS.length)];

// ── CORS ─────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── HTTPS GET helper with gzip support ───────────────────────
function httpsGet(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      const isGzip = (res.headers["content-encoding"] || "").includes("gzip");
      const stream = isGzip ? res.pipe(zlib.createGunzip()) : res;
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => resolve({ status: res.status || res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ── Step 1: Get NSE homepage cookies ─────────────────────────
async function refreshSession() {
  const ua = randUA();
  session.ua = ua;

  // First hit the main page
  const home = await httpsGet({
    hostname: "www.nseindia.com",
    path: "/",
    method: "GET",
    headers: {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  const raw = (home.headers["set-cookie"] || []);
  const cookies = raw.map(c => c.split(";")[0]).join("; ");
  session.cookies = cookies;
  session.lastRefresh = Date.now();

  // Then hit the option chain page to get more cookies
  try {
    const oc = await httpsGet({
      hostname: "www.nseindia.com",
      path: "/option-chain",
      method: "GET",
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://www.nseindia.com/",
        "Cookie": cookies,
        "Connection": "keep-alive",
      },
    });
    const raw2 = (oc.headers["set-cookie"] || []);
    const cookies2 = [...new Set([...raw.map(c=>c.split(";")[0]), ...raw2.map(c=>c.split(";")[0])])].join("; ");
    session.cookies = cookies2;
  } catch(e) { /* use homepage cookies */ }

  console.log("[session] Refreshed. Cookies:", session.cookies.substring(0, 60) + "...");
  return session;
}

// ── Step 2: Call NSE API with session ────────────────────────
async function nseApi(apiPath) {
  // Refresh session if older than 4 minutes
  if (!session.cookies || Date.now() - session.lastRefresh > 4 * 60 * 1000) {
    await refreshSession();
  }

  const res = await httpsGet({
    hostname: "www.nseindia.com",
    path: apiPath,
    method: "GET",
    headers: {
      "User-Agent": session.ua,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Referer": "https://www.nseindia.com/option-chain",
      "X-Requested-With": "XMLHttpRequest",
      "Connection": "keep-alive",
      "Cookie": session.cookies,
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });

  // If blocked, refresh session and retry once
  if (res.status === 401 || res.status === 403 || res.status === 500) {
    console.log("[nseApi] Got", res.status, "— refreshing session and retrying...");
    await refreshSession();
    const retry = await httpsGet({
      hostname: "www.nseindia.com",
      path: apiPath,
      method: "GET",
      headers: {
        "User-Agent": session.ua,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://www.nseindia.com/option-chain",
        "X-Requested-With": "XMLHttpRequest",
        "Connection": "keep-alive",
        "Cookie": session.cookies,
      },
    });
    return retry;
  }
  return res;
}

// ── Cache ─────────────────────────────────────────────────────
const cache = {};
function getCache(key) {
  const c = cache[key];
  if (c && Date.now() - c.time < 25000) return c.data; // 25s cache
  return null;
}
function setCache(key, data) { cache[key] = { data, time: Date.now() }; }

// ── Transform NSE option chain response ──────────────────────
function transform(nseData) {
  if (!nseData || !nseData.records) return null;
  const records = nseData.records;
  const filtered = nseData.filtered || {};
  const last_price = filtered.underlyingValue || records.underlyingValue || 0;
  const expiryDates = records.expiryDates || [];
  const oc = {};
  (records.data || []).forEach(item => {
    const s = item.strikePrice;
    if (!oc[s]) oc[s] = {};
    if (item.CE) oc[s].ce = {
      last_price: item.CE.lastPrice || 0,
      top_bid_price: item.CE.bidprice || 0,
      top_ask_price: item.CE.askPrice || 0,
      oi: item.CE.openInterest || 0,
      previous_oi: item.CE.prevOpenInterest || item.CE.pchangeinOpenInterest || 0,
      volume: item.CE.totalTradedVolume || 0,
      implied_volatility: item.CE.impliedVolatility || 0,
      greeks: { delta: item.CE.delta || null, theta: item.CE.theta || null, gamma: item.CE.gamma || null, vega: item.CE.vega || null },
    };
    if (item.PE) oc[s].pe = {
      last_price: item.PE.lastPrice || 0,
      top_bid_price: item.PE.bidprice || 0,
      top_ask_price: item.PE.askPrice || 0,
      oi: item.PE.openInterest || 0,
      previous_oi: item.PE.prevOpenInterest || item.PE.pchangeinOpenInterest || 0,
      volume: item.PE.totalTradedVolume || 0,
      implied_volatility: item.PE.impliedVolatility || 0,
      greeks: { delta: item.PE.delta || null, theta: item.PE.theta || null, gamma: item.PE.gamma || null, vega: item.PE.vega || null },
    };
  });
  return { last_price, expiryDates, oc };
}

// ── Symbol map ────────────────────────────────────────────────
const SYMBOLS = { NIFTY:"NIFTY", SENSEX:"SENSEX", BANKNIFTY:"BANKNIFTY", FINNIFTY:"FINNIFTY", MIDCPNIFTY:"MIDCPNIFTY" };

// ── Main server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  const send = (code, data) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  // ── Health ──
  if (path === "/" || path === "/health") {
    return send(200, { status: "ok", message: "NSE Proxy v2 running", time: new Date().toISOString() });
  }

  // ── /expiries?symbol=NIFTY ──
  if (path === "/expiries") {
    const sym = SYMBOLS[url.searchParams.get("symbol")] || "NIFTY";
    const cKey = "exp_" + sym;
    const cached = getCache(cKey);
    if (cached) return send(200, cached);
    try {
      const r = await nseApi(`/api/option-chain-indices?symbol=${sym}`);
      const data = JSON.parse(r.body);
      const expiries = data?.records?.expiryDates || [];
      if (!expiries.length) return send(500, { error: "No expiries found. Market may be closed." });
      setCache(cKey, expiries);
      return send(200, expiries);
    } catch(e) {
      return send(500, { error: e.message });
    }
  }

  // ── /chain?symbol=NIFTY&expiry=26-Jun-2025 ──
  if (path === "/chain") {
    const sym = SYMBOLS[url.searchParams.get("symbol")] || "NIFTY";
    const expiry = url.searchParams.get("expiry") || "";
    const cKey = `chain_${sym}_${expiry}`;
    const cached = getCache(cKey);
    if (cached) return send(200, cached);
    try {
      const r = await nseApi(`/api/option-chain-indices?symbol=${sym}`);
      if (r.status !== 200) return send(r.status, { error: `NSE returned ${r.status}. Market may be closed or IP blocked.` });
      const raw = JSON.parse(r.body);
      let transformed = transform(raw);
      if (!transformed) return send(500, { error: "Failed to parse NSE response." });
      // Filter by expiry if provided
      if (expiry && raw.records?.data) {
        const filteredOc = {};
        raw.records.data.forEach(item => {
          if (item.expiryDate === expiry) {
            const s = item.strikePrice;
            if (!filteredOc[s]) filteredOc[s] = {};
            if (item.CE) filteredOc[s].ce = transformed.oc[s]?.ce;
            if (item.PE) filteredOc[s].pe = transformed.oc[s]?.pe;
          }
        });
        transformed.oc = filteredOc;
      }
      setCache(cKey, transformed);
      return send(200, transformed);
    } catch(e) {
      return send(500, { error: e.message });
    }
  }

  // ── /quote?symbol=NIFTY (spot price only) ──
  if (path === "/quote") {
    const sym = SYMBOLS[url.searchParams.get("symbol")] || "NIFTY";
    try {
      const r = await nseApi(`/api/option-chain-indices?symbol=${sym}`);
      const data = JSON.parse(r.body);
      const price = data?.filtered?.underlyingValue || data?.records?.underlyingValue || 0;
      return send(200, { symbol: sym, price });
    } catch(e) {
      return send(500, { error: e.message });
    }
  }

  return send(404, { error: "Not found" });
});

server.listen(PORT, async () => {
  console.log("==============================================");
  console.log("  OPTIQ LITE - NSE Proxy v2");
  console.log("==============================================");
  console.log("  Port:", PORT);
  console.log("  Endpoints: /health /expiries /chain /quote");
  console.log("==============================================");
  // Pre-warm session on startup
  try {
    await refreshSession();
    console.log("  Session pre-warmed successfully!");
  } catch(e) {
    console.log("  Session pre-warm failed (will retry on first request):", e.message);
  }
});
