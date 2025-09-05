// api/run-scan.js
// v2 — Self-contained batch scanner with on-the-fly indicators (EMA/RSI/MACD) for 1D & 1W

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual  = ["1","true","yes"].includes((url.searchParams.get("manual")||"").toLowerCase());
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, 250, 25);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);

    // 1) Load live symbols (fallback -> data/symbols.json)
    const allSymbols = await getSymbolsForGroupLiveOrFallback(group);
    if (!allSymbols.length) return res.status(400).json({ error: `no symbols for ${group}` });

    // 2) Cut batch
    const start = isManual ? cursor : 0;
    const end   = Math.min(start + batchSize, allSymbols.length);
    const batch = allSymbols.slice(start, end);

    // 3) Scan with indicators (1D, 1W)
    const scanned = await scanSymbols(group, batch);

    // 4) Merge with previous and write back
    const mergedPayload = await mergeAndWriteSignals({
      group,
      updatedAt: new Date().toISOString(),
      results: scanned
    });

    const nextCursor = end < allSymbols.length ? end : null;

    return res.status(200).json({
      ok: true,
      version: "r2-selfcalc",
      group,
      total: allSymbols.length,
      processed: scanned.length,
      start,
      end: end - 1,
      nextCursor,
      batchSize,
      savedCount: mergedPayload.results.length,
      savedPreview: mergedPayload
    });
  } catch (err) {
    console.error("run-scan error:", err);
    return res.status(500).json({ error: "scan failed", detail: String(err) });
  }
}

/* ================================ INDICATORS ================================ */

function ema(values, period) {
  const k = 2 / (period + 1);
  let emaPrev = null;
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) { out.push(null); continue; }
    if (emaPrev == null) emaPrev = v; else emaPrev = v * k + emaPrev * (1 - k);
    out.push(emaPrev);
  }
  return out;
}
function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (i <= period) {
      if (change > 0) gains += change; else losses -= change;
      if (i === period) {
        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out[i] = 100 - (100 / (1 + rs));
      }
      continue;
    }
    // Wilder
    const prevRSI = out[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    gains = (gains * (period - 1) + gain) / period;
    losses = (losses * (period - 1) + loss) / period;
    const rs = losses === 0 ? 100 : gains / losses;
    out[i] = 100 - (100 / (1 + rs));
  }
  return out;
}
function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    (emaFast[i] != null && emaSlow[i] != null) ? (emaFast[i] - emaSlow[i]) : null
  );
  const signalLine = ema(macdLine.map(v => v == null ? 0 : v), signal);
  const hist = macdLine.map((v, i) => (v == null || signalLine[i] == null) ? null : v - signalLine[i]);
  return { macdLine, signalLine, hist };
}

function makeSignalFromPineLogic(closes) {
  // replicate your Pine filter combining EMA crossover + MACD relation + RSI bounds
  const emaFast = ema(closes, 9);
  const emaSlow = ema(closes, 21);
  const rsiArr   = rsi(closes, 14);
  const { macdLine, signalLine } = macd(closes, 12, 26, 9);

  const n = closes.length - 1;
  if (n < 2) return "-";

  const crossUp  = emaFast[n-1] <= emaSlow[n-1] && emaFast[n] > emaSlow[n];
  const crossDn  = emaFast[n-1] >= emaSlow[n-1] && emaFast[n] < emaSlow[n];
  const macdUp   = macdLine[n] != null && signalLine[n] != null && macdLine[n] > signalLine[n];
  const macdDn   = macdLine[n] != null && signalLine[n] != null && macdLine[n] < signalLine[n];
  const rsiNow   = rsiArr[n];

  const buy = crossUp && macdUp && rsiNow != null && rsiNow < 70;
  const sell = crossDn || macdDn || (rsiNow != null && rsiNow > 80);
  if (buy) return "Buy";
  if (sell) return "Sell";
  return "-";
}

/* ============================ PRICE FETCHERS ============================ */
// Yahoo Finance (equities/ETFs/SET via suffix .BK)
async function yahooCloses(symbol, interval = "1d", range = "2y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`Yahoo ${symbol} ${r.status}`);
  const js = await r.json();
  const res = js?.chart?.result?.[0];
  const closes = res?.indicators?.quote?.[0]?.close || [];
  return closes.filter(v => Number.isFinite(v));
}

// Binance USDT spot
async function binanceCloses(symbol, interval = "1d", limit = 400) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`Binance ${symbol} ${r.status}`);
  const js = await r.json();
  return js.map(k => Number(k[4])).filter(Number.isFinite); // close
}

// OKX: instId like "BTC-USDT"
async function okxCloses(instId, bar = "1D", limit = 400) {
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`;
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`OKX ${instId} ${r.status}`);
  const js = await r.json();
  const data = js?.data || [];
  return data.reverse().map(k => Number(k[4])).filter(Number.isFinite); // close
}

// Bitkub TradingView endpoint (THB_xxx)
async function bitkubCloses(tvSymbol, resolution = "1D", limit = 400) {
  // tvSymbol form: "THB_BTC"
  const url = `https://api.bitkub.com/tradingview/history?symbol=${tvSymbol}&resolution=${resolution}&from=${Math.floor(Date.now()/1000)-400*86400}&to=${Math.floor(Date.now()/1000)}`;
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`Bitkub ${tvSymbol} ${r.status}`);
  const js = await r.json();
  return (js?.c || []).filter(Number.isFinite);
}

/* ============================== SCANNER ============================== */

async function scanSymbols(group, symbols) {
  const out = [];
  for (const ticker of symbols) {
    try {
      const sig = await computeForTicker(group, ticker);
      out.push(sig);
    } catch (e) {
      console.warn(`[scan] ${group}:${ticker} failed:`, e?.message || e);
      out.push({
        ticker, signalD: "-", signalW: "-", price: null, timeframe: "1D"
      });
    }
  }
  return out;
}

async function computeForTicker(group, ticker) {
  // Map to price source + symbol formatting
  let closesD = [];
  let closesW = [];
  let price = null;

  if (group === "sp500" || group === "nasdaq100" || group === "etfs" || group === "set50" || group === "set100") {
    const yahooSymbol =
      (group === "set50" || group === "set100")
        ? `${ticker}.BK`
        : ticker;
    closesD = await yahooCloses(yahooSymbol, "1d", "2y");
    closesW = await yahooCloses(yahooSymbol, "1wk", "5y");
    price   = closesD.length ? closesD.at(-1) : null;
  }
  else if (group === "binance_top200" || group === "altcoins") {
    // All in USDT form e.g., BTCUSDT
    const sym = ticker.replace(/[^A-Z0-9]/g,"");
    closesD = await binanceCloses(sym, "1d", 500);
    closesW = await binanceCloses(sym, "1w", 500);
    price   = closesD.length ? closesD.at(-1) : null;
  }
  else if (group === "okx_top200") {
    // OKX format: BTC-USDT
    const inst = ticker.includes("-") ? ticker : `${ticker.replace(/USDT$/,"")}-USDT`;
    closesD = await okxCloses(inst, "1D", 500);
    closesW = await okxCloses(inst, "1W", 500);
    price   = closesD.length ? closesD.at(-1) : null;
  }
  else if (group === "bitkub") {
    // Our ticker is like "BTC_THB" => TV uses "THB_BTC"
    const [coin, fiat] = ticker.split("_"); // BTC_THB
    const tv = `${fiat}_${coin}`;           // THB_BTC
    closesD = await bitkubCloses(tv, "1D", 500);
    closesW = await bitkubCloses(tv, "1W", 500);
    price   = closesD.length ? closesD.at(-1) : null;
  }
  else if (group === "gold") {
    // Two symbols: "GC=F", "XAUUSD=X" from Yahoo
    closesD = await yahooCloses(ticker, "1d", "2y");
    closesW = await yahooCloses(ticker, "1wk", "5y");
    price   = closesD.length ? closesD.at(-1) : null;
  } else {
    closesD = [];
    closesW = [];
  }

  const signalD = closesD.length ? makeSignalFromPineLogic(closesD) : "-";
  const signalW = closesW.length ? makeSignalFromPineLogic(closesW) : "-";

  return {
    ticker,
    signalD,
    signalW,
    price: price ?? null,
    timeframe: "1D"
  };
}

/* ============================ LIVE SYMBOLS ============================ */

async function getSymbolsForGroupLiveOrFallback(group) {
  try {
    const live = await getSymbolsLive(group);
    if (Array.isArray(live) && live.length) return uniq(live);
  } catch (e) {
    console.warn(`[symbols-live] ${group} failed:`, e?.message || e);
  }
  // fallback → data/symbols.json
  try {
    const json = await ghReadJSON(
      process.env.GH_PATH_SYMBOLS || "data/symbols.json",
      process.env.GH_REPO_SYMBOLS || process.env.GH_REPO,
      process.env.GH_BRANCH || "main"
    );
    return uniq(Array.isArray(json?.[group]) ? json[group] : []);
  } catch (e2) {
    console.warn(`[symbols-fallback] ${group} failed:`, e2?.message || e2);
    return [];
  }
}

async function getSymbolsLive(group) {
  switch (group) {
    case "sp500":
      return await fetchSP500Slickcharts().catch(async () => await fetchSP500Datahub());
    case "nasdaq100":
      return await fetchNasdaq100Wikipedia();
    case "bitkub":
      return await fetchBitkubTHB();
    case "set50":
      return await fetchSETWikipedia("set50");
    case "set100":
      return await fetchSETWikipedia("set100");
    case "okx_top200":
      return await fetchOKXTopN(200);
    case "binance_top200":
      return await fetchBinanceTopN(200);
    case "altcoins":
      return await fetchOKXTopN(100); // Altcoins(OKX) Top 100
    case "etfs":
      return ["SPY","QQQ","VTI","DIA","ARKK","IWM","EEM","GLD","XLK","XLF","SCHD","IVV","VOO","O","MSTY","VNQ","EFA","XLE","XLY","XLP","XLV","IEMG"];
    case "gold":
      return ["GC=F","XAUUSD=X"];
    default:
      return [];
  }
}

// S&P500 (หลัก)
async function fetchSP500Slickcharts() {
  const url = "https://www.slickcharts.com/sp500";
  const html = await (await fetch(url, UA())).text();
  const re = /<td class="text-center">([A-Z.\-]{1,7})<\/td>/g;
  const out = new Set();
  let m;
  while ((m = re.exec(html))) out.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(out);
  if (arr.length < 400) throw new Error("slickcharts parse too small");
  return arr.slice(0, 500);
}
// S&P500 สำรอง
async function fetchSP500Datahub() {
  const url = "https://datahub.io/core/s-and-p-500-companies/r/constituents.json";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`datahub ${r.status}`);
  const js = await r.json();
  return js.map(x => String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
}

// Nasdaq100
async function fetchNasdaq100Wikipedia() {
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set).filter(x => /^[A-Z\-]+$/.test(x));
  if (arr.length < 80) throw new Error("nas100 parse small");
  return arr.slice(0, 100);
}

// SET50/SET100
async function fetchSETWikipedia(which) {
  const page = which === "set50" ? "SET50_Index" : "SET100_Index";
  const url = `https://en.wikipedia.org/wiki/${page}`;
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1].toUpperCase());
  const arr = Array.from(set).filter(x => /^[A-Z]{2,6}$/.test(x));
  if (which === "set50"  && arr.length < 40)  throw new Error("set50 parse small");
  if (which === "set100" && arr.length < 80)  throw new Error("set100 parse small");
  return arr.slice(0, which === "set50" ? 50 : 100);
}

// Bitkub — ทุกคู่ THB
async function fetchBitkubTHB() {
  const url = "https://api.bitkub.com/api/market/symbols";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`bitkub ${r.status}`);
  const js = await r.json();
  const out = [];
  for (const it of js?.result || []) {
    const raw = String(it.symbol || ""); // "THB_BTC"
    const [fiat, coin] = raw.split("_");
    if (fiat === "THB" && coin) out.push(`${coin}_THB`); // BTC_THB
  }
  return uniq(out).sort();
}

// Binance TopN by USDT quote volume (filter stablecoins)
async function fetchBinanceTopN(N = 200) {
  const url = "https://api.binance.com/api/v3/ticker/24hr";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`binance tickers ${r.status}`);
  const js = await r.json();
  const rows = js
    .filter(x => /USDT$/.test(x.symbol))
    .filter(x => !/^USDC|^BUSD|^FDUSD|^TUSD/.test(x.symbol)) // ตัด stable หลักออก
    .sort((a,b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, N)
    .map(x => x.symbol.toUpperCase());
  return uniq(rows);
}

// OKX TopN by 24h volume (USDT spot)
async function fetchOKXTopN(N = 200) {
  const url = "https://www.okx.com/api/v5/market/tickers?instType=SPOT";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`okx tickers ${r.status}`);
  const js = await r.json();
  const rows = (js?.data || [])
    .filter(x => /-USDT$/.test(x.instId))
    .sort((a,b) => Number(b.volCcy24h || 0) - Number(a.volCcy24h || 0))
    .slice(0, N)
    .map(x => x.instId.toUpperCase()); // "BTC-USDT"
  return uniq(rows);
}

/* ================================ GitHub I/O =============================== */

async function ghReadJSON(path, repo, branch) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op: "read", path, repo: repo||"", branch: branch||"" }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ghRead ${r.status} ${await r.text()}`);
  return r.json();
}

async function ghWrite(path, repo, branch, content, message) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op: "write", path, repo: repo||"", branch: branch||"" }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, message })
  });
  if (!r.ok) throw new Error(`ghWrite ${r.status} ${await r.text()}`);
  return r.json();
}

/**
 * mergeAndWriteSignals:
 * - load previous data/signals.json
 * - if same group → merge by ticker (new overwrites old)
 * - write back with updatedAt
 */
async function mergeAndWriteSignals(payload) {
  const repo   = process.env.GH_REPO || process.env.GH_REPO_SYMBOLS;
  const branch = process.env.GH_BRANCH || "main";
  const path   = process.env.GH_PATH_SIGNALS || "data/signals.json";

  let prev = {};
  try { prev = await ghReadJSON(path, repo, branch); } catch {}

  let map = new Map();
  if (prev?.group === payload.group && Array.isArray(prev?.results)) {
    for (const r of prev.results) map.set(r.ticker, r);
  }
  for (const r of payload.results) map.set(r.ticker, r);

  // Sort: BUY ก่อน, ตามด้วย SELL, ที่เหลือ "-"
  const arr = Array.from(map.values()).sort((a,b) => {
    const score = v => v.signalD === "Buy" || v.signalW === "Buy" ? 0
                      : (v.signalD === "Sell" || v.signalW === "Sell") ? 1 : 2;
    return score(a) - score(b) || a.ticker.localeCompare(b.ticker);
  });

  const merged = { group: payload.group, updatedAt: payload.updatedAt, results: arr };
  await ghWrite(path, repo, branch, JSON.stringify(merged, null, 2), `update signals ${payload.group}`);
  return merged;
}

/* ================================= Utils ================================== */

const UA = () => ({ headers: { "User-Agent": "signal-dashboard/1.1" } });

function clampInt(v, min, max, def) {
  const n = parseInt(v ?? "", 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}
const uniq = arr => Array.from(new Set((arr||[]).map(s => String(s||"").trim()).filter(Boolean)));
