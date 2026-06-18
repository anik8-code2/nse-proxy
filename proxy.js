// ============================================================
// DHAN PAPER TRADER - NSE PROXY SERVER
// Fetches live option chain data from NSE India website.
// No API key needed. Runs free on Render.com
// ============================================================

const https = require("https");
const http = require("http");

const PORT = process.env.PORT || 4000;

// NSE requires these headers to not block requests
const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://www.nseindia.com/option-chain",
  "Connection": "keep-alive",
};

// We store NSE cookies here so we don't need to fetch them every time
let nseSession = {
  cookies: "",
  lastFetched: 0,
};

// Cache option chain data to avoid hitting NSE too often
let cache = {};

// ── CORS headers so our app can call this proxy ───────────────
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── Fetch fresh NSE session cookies ──────────────────────────
function fetchNseCookies() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "www.nseindia.com",
      path: "/",
      method: "GET",
      headers: NSE_HEADERS,
    }, (res) => {
      const raw = res.headers["set-cookie"] || [];
      const cookies = raw.map(c => c.split(";")[0]).join("; ");
      nseSession.cookies = cookies;
      nseSession.lastFetched = Date.now();
      console.log("NSE cookies refreshed");
      resolve(cookies);
    });
    req.on("error", () => resolve(""));
    req.end();
  });
}

// ── Fetch data from NSE API ───────────────────────────────────
function fetchNseData(path) {
  return new Promise(async (resolve, reject) => {
    // Refresh cookies if older than 5 minutes
    if (!nseSession.cookies || Date.now() - nseSession.lastFetched > 5 * 60 * 1000) {
      await fetchNseCookies();
    }

    const req = https.request({
      hostname: "www.nseindia.com",
      path: path,
      method: "GET",
      headers: {
        ...NSE_HEADERS,
        "Cookie": nseSession.cookies,
      },
    }, (res) => {
      let data = "";
      // Handle gzip
      let stream = res;
      if (res.headers["content-encoding"] === "gzip") {
        const zlib = require("zlib");
        stream = res.pipe(zlib.createGunzip());
      }
      stream.on("data", chunk => data += chunk);
      stream.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          // Cookie may have expired, try refreshing once
          fetchNseCookies().then(() => {
            reject(new Error("Cookie refresh needed, please retry"));
          });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ── Symbol map: our app name -> NSE symbol ───────────────────
const SYMBOL_MAP = {
  NIFTY:      "NIFTY",
  BANKNIFTY:  "BANKNIFTY",
  FINNIFTY:   "FINNIFTY",
  MIDCPNIFTY: "MIDCPNIFTY",
  SENSEX:     "SENSEX",
};

// ── Transform NSE data to our app's format ───────────────────
function transformChain(nseData, symbol) {
  if (!nseData || !nseData.records) return null;

  const records = nseData.records;
  const filtered = nseData.filtered || {};

  // Spot price
  const last_price = filtered.underlyingValue || records.underlyingValue || 0;

  // Expiry dates
  const expiryDates = records.expiryDates || [];

  // Build option chain object keyed by strike
  const oc = {};
  (records.data || []).forEach(item => {
    const strike = item.strikePrice;
    if (!oc[strike]) oc[strike] = {};

    if (item.CE) {
      oc[strike].ce = {
        last_price:         item.CE.lastPrice || 0,
        top_bid_price:      item.CE.bidprice || 0,
        top_ask_price:      item.CE.askPrice || 0,
        oi:                 item.CE.openInterest || 0,
        previous_oi:        item.CE.pchangeinOpenInterest || 0,
        volume:             item.CE.totalTradedVolume || 0,
        implied_volatility: item.CE.impliedVolatility || 0,
        greeks: {
          delta: item.CE.delta || null,
          theta: item.CE.theta || null,
          gamma: item.CE.gamma || null,
          vega:  item.CE.vega  || null,
        },
      };
    }

    if (item.PE) {
      oc[strike].pe = {
        last_price:         item.PE.lastPrice || 0,
        top_bid_price:      item.PE.bidprice || 0,
        top_ask_price:      item.PE.askPrice || 0,
        oi:                 item.PE.openInterest || 0,
        previous_oi:        item.PE.pchangeinOpenInterest || 0,
        volume:             item.PE.totalTradedVolume || 0,
        implied_volatility: item.PE.impliedVolatility || 0,
        greeks: {
          delta: item.PE.delta || null,
          theta: item.PE.theta || null,
          gamma: item.PE.gamma || null,
          vega:  item.PE.vega  || null,
        },
      };
    }
  });

  return { last_price, expiryDates, oc };
}

// ── HTTP Server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health check
  if (path === "/" || path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", message: "NSE proxy is running" }));
    return;
  }

  // ── GET /chain?symbol=NIFTY&expiry=29-May-2026 ──
  if (path === "/chain") {
    const symbol = url.searchParams.get("symbol") || "NIFTY";
    const expiry = url.searchParams.get("expiry") || "";
    const nseSymbol = SYMBOL_MAP[symbol] || symbol;

    // Check cache (30 second cache to avoid hitting NSE too often)
    const cacheKey = `${symbol}_${expiry}`;
    const cached = cache[cacheKey];
    if (cached && Date.now() - cached.time < 30000) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cached.data));
      return;
    }

    try {
      const nsePath = `/api/option-chain-indices?symbol=${nseSymbol}`;
      const nseData = await fetchNseData(nsePath);
      let transformed = transformChain(nseData, symbol);

      // Filter by expiry if provided
      if (expiry && transformed) {
        const filteredOc = {};
        const records = nseData.records?.data || [];
        records.forEach(item => {
          if (item.expiryDate === expiry) {
            const strike = item.strikePrice;
            if (!filteredOc[strike]) filteredOc[strike] = {};
            if (item.CE) filteredOc[strike].ce = transformed.oc[strike]?.ce;
            if (item.PE) filteredOc[strike].pe = transformed.oc[strike]?.pe;
          }
        });
        transformed.oc = filteredOc;
      }

      cache[cacheKey] = { data: transformed, time: Date.now() };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(transformed));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /expiries?symbol=NIFTY ──
  if (path === "/expiries") {
    const symbol = url.searchParams.get("symbol") || "NIFTY";
    const nseSymbol = SYMBOL_MAP[symbol] || symbol;
    const cacheKey = `expiries_${symbol}`;
    const cached = cache[cacheKey];
    if (cached && Date.now() - cached.time < 60000) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cached.data));
      return;
    }
    try {
      const nseData = await fetchNseData(`/api/option-chain-indices?symbol=${nseSymbol}`);
      const expiries = nseData?.records?.expiryDates || [];
      cache[cacheKey] = { data: expiries, time: Date.now() };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(expiries));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /quote?symbol=NIFTY (spot price only) ──
  if (path === "/quote") {
    const symbol = url.searchParams.get("symbol") || "NIFTY";
    const nseSymbol = SYMBOL_MAP[symbol] || symbol;
    try {
      const nseData = await fetchNseData(`/api/option-chain-indices?symbol=${nseSymbol}`);
      const price = nseData?.filtered?.underlyingValue || nseData?.records?.underlyingValue || 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ symbol, price }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, async () => {
  console.log("==============================================");
  console.log("  F&O PAPER TRADER - NSE Proxy Running       ");
  console.log("==============================================");
  console.log("  Port   : " + PORT);
  console.log("  Source : NSE India (No API key needed)");
  console.log("----------------------------------------------");
  console.log("  Endpoints:");
  console.log("  /health            - Check server status");
  console.log("  /expiries?symbol=NIFTY");
  console.log("  /chain?symbol=NIFTY&expiry=29-May-2026");
  console.log("  /quote?symbol=NIFTY");
  console.log("==============================================");
  // Pre-fetch NSE cookies on startup
  await fetchNseCookies();
  console.log("  Ready to serve requests!");
});
