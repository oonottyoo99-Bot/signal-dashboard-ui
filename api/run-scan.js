// api/run-scan.js
// v12 — complete lists + batch scan + indicator engine (EMA/RSI/MACD) + GH write retry

export default async function handler(req, res) {
  try {
    const url   = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual  = ["1","true","yes"].includes((url.searchParams.get("manual")||"").toLowerCase());
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, 400, 50);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);

    // 1) load full symbol list (live first, fallback to symbols.json)
    const allSymbols = await getSymbolsForGroupLiveOrFallback(group);
    if (!allSymbols.length) return res.status(400).json({ error: `no symbols for ${group}` });

    // 2) slice batch
    const start = isManual ? cursor : 0;
    const end   = Math.min(start + batchSize, allSymbols.length);
    const batch = allSymbols.slice(start, end);

    // 3) scan batch (indicator engine)
    const scanned = await scanSymbols(group, batch);

    // 4) merge & write with retry (fix 409)
    const mergedPayload = await mergeAndWriteSignalsSafe({
      group,
      updatedAt: new Date().toISOString(),
      results: scanned
    });

    const nextCursor = end < allSymbols.length ? end : null;

    return res.status(200).json({
      ok: true,
      version: "r12",
      group,
      total: allSymbols.length,
      processed: scanned.length,
      start,
      end: end - 1,
      nextCursor,
      batchSize,
      savedCount: scanned.length,
      savedPreview: mergedPayload
    });
  } catch (err) {
    console.error("run-scan error:", err);
    return res.status(500).json({ error: "scan failed", detail: String(err) });
  }
}

/* ============================== INDICATOR ENGINE ============================== */
/**
 * Pine logic equivalent:
 *  - EMA fast = 9, EMA slow = 21
 *  - RSI length 14
 *  - MACD 12/26 signal 9
 * buy  = crossover(ema9, ema21) && macd > macdSignal && rsi < 70
 * sell = crossunder(ema9, ema21) || macd < macdSignal || rsi > 80
 */
const PINE = {
  emaFast: 9, emaSlow: 21,
  rsiLen: 14,
  macdFast: 12, macdSlow: 26, macdSig: 9
};

async function scanSymbols(group, symbols) {
  const out = [];
  for (const ticker of symbols) {
    try {
      const [sigD, priceD] = await computeSignal(group, ticker, "1D");
      const [sigW]        = await computeSignal(group, ticker, "1W");

      out.push({
        ticker,
        signalD: sigD,
        signalW: sigW,
        price: priceD == null ? null : Number(priceD).toFixed(2),
        timeframe: "1D"
      });
    } catch (e) {
      out.push({ ticker, signalD: "-", signalW: "-", price: null, timeframe: "1D" });
    }
  }
  // อันดับ “Buy” ขึ้นก่อน (ถ้ามี)
  out.sort((a,b) => rankScore(b) - rankScore(a));
  return out;
}
const rankScore = (r) => (r.signalD === "Buy" || r.signalW === "Buy") ? 1 : 0;

/** computeSignal -> [signal, lastPrice] */
async function computeSignal(group, ticker, tf) {
  const candles = await fetchCandles(group, ticker, tf, 200);
  if (!candles || candles.length < 50) return ["-", null]; // ข้อมูลไม่พอ
  const closes = candles.map(c => Number(c.close));

  const emaF = EMA(closes, PINE.emaFast);
  const emaS = EMA(closes, PINE.emaSlow);
  const rsi  = RSI(closes, PINE.rsiLen);
  const [macd, sig] = MACD(closes, PINE.macdFast, PINE.macdSlow, PINE.macdSig);

  const n  = closes.length - 1;
  const cs = crossover(emaF, emaS);
  const cu = crossunder(emaF, emaS);

  const condBuy  = cs && macd[n] > sig[n] && rsi[n] < 70;
  const condSell = cu || macd[n] < sig[n] || rsi[n] > 80;

  const signal = condBuy ? "Buy" : (condSell ? "Sell" : "-");
  const last   = closes[n];

  return [signal, last];
}

// helpers for TA
function EMA(series, len) {
  const out = new Array(series.length).fill(NaN);
  if (series.length === 0) return out;
  const k = 2 / (len + 1);
  let ema = series[0];
  for (let i=0;i<series.length;i++){
    const v = series[i];
    ema = i===0 ? v : (v - ema) * k + ema;
    out[i] = ema;
  }
  return out;
}
function SMA(series, len) {
  const out = new Array(series.length).fill(NaN);
  let sum = 0;
  for (let i=0;i<series.length;i++){
    sum += series[i];
    if (i >= len) sum -= series[i-len];
    if (i >= len-1) out[i] = sum/len;
  }
  return out;
}
function RSI(series, len){
  const out = new Array(series.length).fill(NaN);
  let gains=0, losses=0;
  for (let i=1;i<series.length;i++){
    const ch = series[i]-series[i-1];
    const g = Math.max(ch,0), l=Math.max(-ch,0);
    if (i<=len){ gains+=g; losses+=l; if(i===len){ const rs=gains/(losses||1e-9); out[i]=100-100/(1+rs);} }
    else{
      gains=(gains*(len-1)+g)/len;
      losses=(losses*(len-1)+l)/len;
      const rs=gains/(losses||1e-9);
      out[i]=100-100/(1+rs);
    }
  }
  return out;
}
function MACD(series, fast=12, slow=26, sig=9){
  const emaF = EMA(series, fast);
  const emaS = EMA(series, slow);
  const macd = emaF.map((v,i)=> v-emaS[i]);
  const signal = EMA(macd, sig);
  return [macd, signal];
}
function crossover(a,b){
  const n=a.length-1;
  if(n<1) return false;
  return a[n-1] <= b[n-1] && a[n] > b[n];
}
function crossunder(a,b){
  const n=a.length-1;
  if(n<1) return false;
  return a[n-1] >= b[n-1] && a[n] < b[n];
}

/* =============================== DATA FEEDS =============================== */
/**
 * รูปแบบ candle: { time, open, high, low, close } (เรียงจากเก่า -> ใหม่)
 */
async function fetchCandles(group, ticker, tf, limit=200){
  try{
    if (group === "binance_top200" || /^[A-Z0-9]+USDT$/.test(ticker)){
      const sym = ticker.replace(/[^A-Z0-9]/g,"");
      const interval = tf === "1W" ? "1w" : "1d";
      const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
      const js  = await (await fetch(url, UA())).json();
      return js.map(k => ({ time: k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4] }));
    }
    if (group === "okx_top200" || group === "altcoins" || /-USDT$/.test(ticker)){
      const inst = ticker.includes("-") ? ticker : `${ticker.slice(0,-4)}-${ticker.slice(-4)}`;
      const bar = tf === "1W" ? "1W" : "1D";
      const url = `https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${bar}&limit=${limit}`;
      const js  = await (await fetch(url, UA())).json();
      const arr = (js?.data||[]).slice().reverse();
      return arr.map(k=>({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4] }));
    }
    if (group === "bitkub" || /_THB$/.test(ticker)){
      // Bitkub TradingView endpoint (server-side ok)
      const sym = ticker.replace("_THB","").toUpperCase();
      const pair = `THB_${sym}`;
      const resolution = tf === "1W" ? "1W" : "1D";
      const to  = Math.floor(Date.now()/1000);
      const from= to - 60*60*24*365*3; // 3y
      const url = `https://api.bitkub.com/tradingview/history?symbol=${pair}&resolution=${resolution}&from=${from}&to=${to}`;
      const js  = await (await fetch(url, UA())).json();
      if (js?.s !== "ok") return [];
      const arr = [];
      for (let i=0;i<js.t.length;i++){
        arr.push({ time: js.t[i]*1000, open:+js.o[i], high:+js.h[i], low:+js.l[i], close:+js.c[i] });
      }
      return arr;
    }
    // US stocks / ETFs / Gold / SET (Yahoo Finance)
    const ySym = mapYahoo(ticker, group);
    const interval = tf === "1W" ? "1wk" : "1d";
    const range    = "2y";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?range=${range}&interval=${interval}`;
    const js  = await (await fetch(url, UA())).json();
    const r   = js?.chart?.result?.[0];
    const t   = r?.timestamp || [];
    const o   = r?.indicators?.quote?.[0]?.open  || [];
    const h   = r?.indicators?.quote?.[0]?.high  || [];
    const l   = r?.indicators?.quote?.[0]?.low   || [];
    const c   = r?.indicators?.quote?.[0]?.close || [];
    const arr = [];
    for (let i=0;i<t.length;i++){
      arr.push({ time:t[i]*1000, open:+o[i], high:+h[i], low:+l[i], close:+c[i] });
    }
    return arr.filter(x=>isFinite(x.close));
  }catch(e){
    return [];
  }
}

// map to Yahoo symbols
function mapYahoo(ticker, group){
  if (group === "set50" || group === "set100"){
    // SET on Yahoo ends with .BK
    return `${ticker}.BK`;
  }
  // ETFs & US stocks: as-is (SPY, QQQ, SCHD ...)
  // Gold futures / spot keep original e.g., GC=F, XAUUSD=X
  return ticker;
}

/* ======================= SYMBOL LISTS (LIVE + FALLBACK) ======================= */

async function getSymbolsForGroupLiveOrFallback(group) {
  try {
    const live = await getSymbolsLive(group);
    if (Array.isArray(live) && live.length) return uniq(live);
  } catch (e) {
    console.warn(`[symbols-live fail] ${group}:`, e?.message || e);
  }
  // fallback → data/symbols.json (ถ้ามี)
  try {
    const json = await ghReadJSON(
      process.env.GH_PATH_SYMBOLS || "data/symbols.json",
      process.env.GH_REPO_SYMBOLS || process.env.GH_REPO,
      process.env.GH_BRANCH || "main"
    );
    return uniq(Array.isArray(json?.[group]) ? json[group] : []);
  } catch {
    return [];
  }
}

async function getSymbolsLive(group) {
  switch (group) {
    case "sp500":      return await fetchSP500_500();
    case "nasdaq100":  return await fetchNasdaq100_100();
    case "altcoins":   return await fetchOKX_TopUSDT(100);   // 100
    case "binance_top200": return await fetchBinance_TopUSDT(200); // 200
    case "okx_top200": return await fetchOKX_TopUSDT(200);   // 200
    case "bitkub":     return await fetchBitkubTHB_All();    // all _THB
    case "set50":      return await fetchSETWikipedia("set50");
    case "set100":     return await fetchSETWikipedia("set100");
    case "etfs":       return ["SPY","QQQ","VOO","IVV","DIA","EEM","ARKK","IWM","O","MSTY","JEPQ","SCHD","VTI","XLK","XLF","XLE","XLV","XLY","XLP","XLI","XLB","VNQ"]; // 22
    case "gold":       return ["GC=F","XAUUSD=X"];
    default:           return [];
  }
}

// S&P500 via slickcharts (robust) → fallback datahub
async function fetchSP500_500() {
  const url = "https://www.slickcharts.com/sp500";
  const html = await (await fetch(url, UA())).text();
  const set = new Set();

  // try multiple patterns
  const re1 = /<td[^>]*class="text-center"[^>]*>\s*([A-Z.\-]{1,7})\s*<\/td>/g;
  let m; while((m=re1.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));

  const re2 = /\/symbol\/[A-Z.\-]{1,7}"[^>]*>\s*([A-Z.\-]{1,7})\s*<\/a>/g;
  while((m=re2.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));

  let arr = Array.from(set);
  if (arr.length < 450) { // fallback
    const js = await (await fetch("https://datahub.io/core/s-and-p-500-companies/r/constituents.json", UA())).json();
    arr = js.map(x => String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
  }
  return uniq(arr).slice(0,500);
}

// Nasdaq100 Wikipedia
async function fetchNasdaq100_100(){
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  const re  = /<td[^>]*>\s*<a[^>]*>([A-Z.\-]{1,7})<\/a>\s*<\/td>/g;
  let m; while((m=re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set).filter(x=>/^[A-Z\-]+$/.test(x));
  if (arr.length < 100) return arr.slice(0,100); // บางครั้งหน้าแกว่ง
  return arr.slice(0,100);
}

// OKX spot USDT top by vol
async function fetchOKX_TopUSDT(n=200){
  const url = "https://www.okx.com/api/v5/market/tickers?instType=SPOT";
  const js  = await (await fetch(url, UA())).json();
  const list = (js?.data||[])
    .filter(r => /-USDT$/.test(r.instId))
    .map(r => ({ sym: r.instId, vol: +r.vol24h || +r.volCcy24h || 0 }));
  list.sort((a,b)=> b.vol - a.vol);
  return list.slice(0,n).map(r => r.sym);
}

// Binance spot USDT top by quoteVolume
async function fetchBinance_TopUSDT(n=200){
  const ex = await (await fetch("https://api.binance.com/api/v3/exchangeInfo", UA())).json();
  const usdt = (ex?.symbols||[])
    .filter(s => s.quoteAsset === "USDT" && s.status === "TRADING")
    .map(s => s.symbol);
  const tick = await (await fetch("https://api.binance.com/api/v3/ticker/24hr", UA())).json();
  const rank = tick
    .filter(t => usdt.includes(t.symbol))
    .map(t => ({ sym: t.symbol, vol: +t.quoteVolume || 0 }));
  rank.sort((a,b)=> b.vol - a.vol);
  return rank.slice(0,n).map(x => x.sym);
}

// Bitkub all THB pairs
async function fetchBitkubTHB_All(){
  const url = "https://api.bitkub.com/api/market/symbols";
  const js  = await (await fetch(url, UA())).json();
  const out = [];
  for (const it of js?.result || []) {
    const raw = String(it.symbol || ""); // "THB_BTC"
    const [fiat, coin] = raw.split("_");
    if (fiat === "THB" && coin) out.push(`${coin}_THB`);
  }
  return uniq(out).sort();
}

// SET50/SET100 wikipedia
async function fetchSETWikipedia(which){
  const page = which === "set50" ? "SET50_Index" : "SET100_Index";
  const url  = `https://en.wikipedia.org/wiki/${page}`;
  const html = await (await fetch(url, UA())).text();
  const set  = new Set();
  const re   = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m; while((m=re.exec(html))) set.add(m[1].toUpperCase());
  const arr  = Array.from(set).filter(x=>/^[A-Z]{2,6}$/.test(x));
  return arr.slice(0, which==="set50" ? 50 : 100);
}

/* ================================ GitHub I/O ================================ */

async function ghReadJSON(path, repo, branch) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op:"read", path, repo:repo||"", branch:branch||"" }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ghRead ${r.status} ${await r.text()}`);
  return r.json();
}
async function ghWrite(path, repo, branch, content, message) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op:"write", path, repo:repo||"", branch:branch||"" }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ content, message })});
  if (!r.ok) throw new Error(`ghWrite ${r.status} ${await r.text()}`);
  return r.json();
}

// merge results for the same group (atomic with retry)
async function mergeAndWriteSignalsSafe(payload){
  const repo   = process.env.GH_REPO || process.env.GH_REPO_SYMBOLS;
  const branch = process.env.GH_BRANCH || "main";
  const path   = process.env.GH_PATH_SIGNALS || "data/signals.json";

  let attempt = 0;
  while (true){
    attempt++;
    let prev = {};
    try { prev = await ghReadJSON(path, repo, branch); } catch{}
    const map = new Map();
    if (prev?.group === payload.group && Array.isArray(prev.results)){
      for (const r of prev.results) map.set(r.ticker, r);
    }
    for (const r of payload.results) map.set(r.ticker, r);

    const merged = {
      group: payload.group,
      updatedAt: payload.updatedAt,
      results: Array.from(map.values())
    };

    try{
      await ghWrite(path, repo, branch, JSON.stringify(merged, null, 2), `update signals ${payload.group}`);
      return merged;
    }catch(e){
      // handle 409 from GH upstream (backend wraps GH)
      const msg = String(e||"");
      if (attempt < 4 && /409/.test(msg)) {
        await sleep(300 * attempt);
        continue;
      }
      throw e;
    }
  }
}

/* ================================= UTILS ================================= */

const UA = () => ({ headers: { "User-Agent": "signal-dashboard/1.0" } });
function clampInt(v, min, max, def){ const n=parseInt(v??"",10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def; }
const uniq = arr => Array.from(new Set((arr||[]).map(s => String(s||"").trim()).filter(Boolean)));
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
