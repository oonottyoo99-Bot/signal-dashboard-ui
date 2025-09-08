// api/run-scan.js
// v13 - batch scan + built-in indicator engine (EMA/RSI/MACD) + GitHub write + Vercel auto-redeploy

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = (k, d = "") => (url.searchParams.get(k) || d).trim();
    const group = q("group").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    // ----- scan controls -----
    const isManual = ["1", "true", "yes"].includes(q("manual"));
    const batchSize = clampInt(q("batchSize"), 1, 500, 200);
    const cursor = clampInt(q("cursor"), 0, 100000, 0);

    // ----- load symbols -----
    const allSymbols = await getSymbolsForGroup(group);
    if (!allSymbols.length)
      return res.status(400).json({ error: `no symbols for ${group}` });

    // slice batch
    const start = isManual ? cursor : 0;
    const end = Math.min(start + batchSize, allSymbols.length);
    const batch = allSymbols.slice(start, end);

    // ----- scan -----
    const scanned = await scanSymbols(group, batch);

    // ----- merge & write to GitHub -----
    const payload = {
      group,
      updatedAt: new Date().toISOString(),
      results: scanned,
    };
    const saved = await mergeAndWriteSignalsSafe(group, payload);

    // ----- build next cursor / meta -----
    const nextCursor = end < allSymbols.length ? end : null;

    // ----- trigger Vercel redeploy (non-blocking) -----
    triggerRedeploy().catch(() => { /* no-op */ });

    return res.status(200).json({
      ok: true,
      version: "v13",
      group,
      total: allSymbols.length,
      processed: batch.length,
      start,
      end: end - 1,
      nextCursor,
      savedCount: saved.count || 0,
      savedPreview: payload,
    });
  } catch (e) {
    return res.status(500).json({ error: "scan failed", detail: String(e) });
  }
}

/* ---------------------- helpers & engines ---------------------- */

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** get symbols list for a group (live first, fallback to repo data) */
async function getSymbolsForGroup(group) {
  const map = {
    sp500: fetchSP500_500,
    nasdaq100: fetchNasdaq100_100,
    altcoins: fetchOKXTop100Alt,
    binance_top200: fetchBinanceTop200,
    okx_top200: fetchOKXTop200,
    bitkub: fetchBitkubAll,
    set50: fetchSET50_50,
    set100: fetchSET100_100,
    etfs: fetchETFsCurated,
    gold: fetchGold2,
  };
  const fn = map[group];
  if (!fn) return [];

  try {
    const live = await fn();
    if (Array.isArray(live) && live.length) return live;
  } catch (_) {
    // ignore and fallback
  }

  // fallback to data/symbols-<group>.json in repo (raw GitHub)
  try {
    const repo = process.env.GH_REPO;
    const branch = process.env.GH_BRANCH || "main";
    const raw =
      `https://raw.githubusercontent.com/${repo}/${branch}/data/symbols-${group}.json`;
    const r = await fetch(raw);
    if (r.ok) {
      const json = await r.json();
      if (Array.isArray(json)) return json;
      if (Array.isArray(json?.symbols)) return json.symbols;
    }
  } catch (_) {}
  return [];
}

/* -------------------- symbol providers (live) ------------------- */

// 1) S&P 500 — slickcharts full 500 as Yahoo symbols
async function fetchSP500_500() {
  const r = await fetch("https://slickcharts.com/api/sp500");
  const j = await r.json();
  // map to Yahoo (some need suffixes but basic works for most)
  return j?.data?.map((x) => x.symbol).filter(Boolean).slice(0, 500) || [];
}

// 2) Nasdaq100 — Wikipedia
async function fetchNasdaq100_100() {
  const r = await fetch(
    "https://en.wikipedia.org/api/rest_v1/page/summary/Nasdaq-100"
  ); // ping keepalive
  // pull from curated raw (more stable)
  const curated =
    "https://pkgstore.datahub.io/core/nasdaq-listings/constituents_json/data/constituents_json.json";
  const r2 = await fetch(curated);
  const j = await r2.json();
  const out = [];
  for (const x of j) {
    if (out.length >= 100) break;
    if (x?.Symbol) out.push(x.Symbol);
  }
  return out;
}

// 3) OKX alt top100 (USDT spot), drop BTC/ETH/stables
async function fetchOKXTop100Alt() {
  const r = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
  const j = await r.json();
  const alts = j?.data
    ?.filter((x) => x.instId.endsWith("-USDT"))
    .map((x) => x.instId.replace("-", "_"));
  const drop = new Set(["BTC_USDT", "ETH_USDT", "USDT_USD", "USDC_USDT", "DAI_USDT"]);
  const out = alts.filter((s) => !drop.has(s)).slice(0, 100);
  return out;
}

// 4) Binance top200 USDT
async function fetchBinanceTop200() {
  const r = await fetch("https://api.binance.com/api/v3/ticker/24hr");
  const j = await r.json();
  const usdt = j.filter((x) => x.symbol.endsWith("USDT"));
  usdt.sort((a, b) => +b.quoteVolume - +a.quoteVolume);
  return usdt.slice(0, 200).map((x) => x.symbol.replace("USDT", "_USDT"));
}

// 5) OKX top200 USDT (by vol)
async function fetchOKXTop200() {
  const r = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
  const j = await r.json();
  const usdt = j?.data
    ?.filter((x) => x.instId.endsWith("-USDT"))
    .sort((a, b) => +b.volCcy24h - +a.volCcy24h)
    .slice(0, 200)
    .map((x) => x.instId.replace("-", "_"));
  return usdt || [];
}

// 6) Bitkub — all THB_*
async function fetchBitkubAll() {
  const r = await fetch("https://api.bitkub.com/api/market/symbols");
  const j = await r.json();
  return j?.result?.map((x) => `${x.symbol}`)?.filter((s) => s.endsWith("_THB")) || [];
}

// 7) SET50
async function fetchSET50_50() {
  const r = await fetch("https://en.wikipedia.org/wiki/SET50_Index");
  await r.text(); // warm
  // ใช้ curated raw (เสถียรกว่า)
  const raw =
    "https://raw.githubusercontent.com/datasets/th-stock-exchanges/main/set50.json";
  const r2 = await fetch(raw);
  const j = await r2.json();
  return j?.symbols?.slice(0, 50) || [];
}

// 8) SET100
async function fetchSET100_100() {
  const raw =
    "https://raw.githubusercontent.com/datasets/th-stock-exchanges/main/set100.json";
  const r = await fetch(raw);
  const j = await r.json();
  return j?.symbols?.slice(0, 100) || [];
}

// 9) ETFs (curated 22)
async function fetchETFsCurated() {
  return [
    "ARKK","DIA","EEM","IVV","IWM","JEPQ","MSTY","O","QQQ","SCHD","SPY","VNQ",
    "VTI","VOO","XLV","XLP","XLY","XLE","XLF","XLI","XLB","IEMG"
  ];
}

// 10) Gold 2 tickers (Futures & Spot)
async function fetchGold2() {
  return ["GC=F", "XAUUSD=X"];
}

/* ------------------- scanning & indicators --------------------- */

async function scanSymbols(group, symbols) {
  const out = [];
  for (const sym of symbols) {
    const one = await scanOne(sym);
    out.push(one);
  }

  // rule: ถ้าพบ BUY (1D/1W) ให้เรียงขึ้นก่อน
  out.sort((a, b) => rankScore(b) - rankScore(a));
  return out;
}

function rankScore(r) {
  let s = 0;
  if (r.signalD === "Buy") s += 2;
  if (r.signalW === "Buy") s += 3;
  return s;
}

async function scanOne(symbol) {
  const prix = await fetchPrice(symbol); // last
  const [d, w] = await Promise.all([
    fetchCandlesYahoo(symbol, "1d", 260),
    fetchCandlesYahoo(symbol, "1wk", 260),
  ]);

  const signalD = computeSignal(d);
  const signalW = computeSignal(w);

  return {
    ticker: symbol,
    signalD,
    signalW,
    price: prix == null ? null : +prix.toFixed(2),
    timeframe: signalW === "-" ? "1D" : "1D",
  };
}

// Yahoo Finance Chart API
async function fetchCandlesYahoo(symbol, interval, bars) {
  const enc = encodeURIComponent(symbol);
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=${interval}&range=max`
  );
  if (!r.ok) return [];
  const j = await r.json();
  const t = j?.chart?.result?.[0];
  const closes = t?.indicators?.quote?.[0]?.close || [];
  return closes.slice(-bars).filter((x) => typeof x === "number");
}

async function fetchPrice(symbol) {
  const closes = await fetchCandlesYahoo(symbol, "1d", 2);
  const p = closes.at(-1);
  return typeof p === "number" ? p : null;
}

/* ----- indicator set (EMA/RSI/MACD) ----- */

function computeSignal(closes) {
  if (!closes || closes.length < 35) return "-";
  const ema9 = EMA(closes, 9);
  const ema21 = EMA(closes, 21);
  const rsi14 = RSI(closes, 14);
  const macd = MACD(closes, 12, 26, 9);

  const last = closes.length - 1;

  const bullCross =
    crossover(ema9[last], ema21[last], ema9[last - 1], ema21[last - 1]) &&
    macd.macd[last] > macd.signal[last] &&
    rsi14[last] < 70;

  const bear =
    crossunder(ema9[last], ema21[last], ema9[last - 1], ema21[last - 1]) ||
    macd.macd[last] < macd.signal[last] ||
    rsi14[last] > 80;

  if (bullCross) return "Buy";
  if (bear) return "Sell";
  return "-";
}

function EMA(arr, len) {
  const k = 2 / (len + 1);
  const out = [];
  let ema = arr[0];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    ema = i === 0 ? v : (v - ema) * k + ema;
    out.push(ema);
  }
  return out;
}

function SMA(arr, len) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= len) sum -= arr[i - len];
    out.push(i >= len - 1 ? sum / len : arr[i]);
  }
  return out;
}

function RSI(arr, len) {
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const ch = arr[i] - arr[i - 1];
    gain += Math.max(0, ch);
    loss += Math.max(0, -ch);
  }
  let avgGain = gain / len;
  let avgLoss = loss / len;
  const out = new Array(arr.length).fill(50);

  for (let i = len + 1; i < arr.length; i++) {
    const ch = arr[i] - arr[i - 1];
    const g = Math.max(0, ch);
    const l = Math.max(0, -ch);
    avgGain = (avgGain * (len - 1) + g) / len;
    avgLoss = (avgLoss * (len - 1) + l) / len;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function MACD(arr, fast, slow, signal) {
  const emaFast = EMA(arr, fast);
  const emaSlow = EMA(arr, slow);
  const macd = emaFast.map((v, i) => v - emaSlow[i]);
  const sig = EMA(macd, signal);
  const hist = macd.map((v, i) => v - sig[i]);
  return { macd, signal: sig, hist };
}

function crossover(a, b, pa, pb) {
  return pa <= pb && a > b;
}
function crossunder(a, b, pa, pb) {
  return pa >= pb && a < b;
}

/* ---------------------- write to GitHub ------------------------ */

async function mergeAndWriteSignalsSafe(group, payload) {
  const repo = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH || "main";
  const token = process.env.GH_TOKEN;

  if (!repo || !token) return { ok: false, reason: "no GH env" };

  const path = "data/signals.json";
  const api = `https://api.github.com/repos/${repo}/contents/${path}`;

  // 1) get current
  let curr = { groups: {} };
  let sha = null;

  const r0 = await fetch(`${api}?ref=${branch}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });

  if (r0.ok) {
    const j = await r0.json();
    sha = j.sha;
    if (j.content) {
      const decoded = JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
      if (decoded && typeof decoded === "object") curr = decoded;
    }
  }

  // 2) merge
  curr.groups[group] = payload;

  // 3) put
  const body = {
    message: `update data/signals.json (${group})`,
    content: Buffer.from(JSON.stringify(curr, null, 2)).toString("base64"),
    branch,
    sha,
  };

  const r1 = await fetch(api, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify(body),
  });

  if (!r1.ok) {
    const txt = await r1.text();
    throw new Error(`ghWrite 500 ${r1.status}: ${txt}`);
  }
  return { ok: true, count: payload.results?.length || 0 };
}

/* --------------------- auto redeploy hook ---------------------- */

async function triggerRedeploy() {
  const hook = process.env.VERCEL_DEPLOY_HOOK;
  if (!hook) return;
  try {
    await fetch(hook, { method: "POST" });
  } catch (_) {
    // ignore
  }
}
