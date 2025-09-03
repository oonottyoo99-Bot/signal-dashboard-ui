// api/run-scan.js
// Batch scan + live symbols (Node runtime) + hard guarantees for counts + robust fallbacks

export const config = { runtime: "nodejs" };

const DEF_BATCH = 100;      // เริ่มทีละ 100 เร็วกว่า
const MAX_BATCH = 300;      // กันไม่ให้เกิน
const TIMEOUT_MS = 15000;

/* ============================== Handler ============================== */
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual  = isTrue(url.searchParams.get("manual"));
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, MAX_BATCH, DEF_BATCH);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);

    // 1) get full list
    const symbols = await getSymbols(group);
    if (!symbols.length) return res.status(400).json({ error: `no symbols for ${group}` });

    // 2) cut batch
    const start = isManual ? cursor : 0;
    const end   = isManual ? Math.min(start + batchSize, symbols.length) : Math.min(batchSize, symbols.length);
    const batch = symbols.slice(start, end);

    // 3) scan indicators (ใส่สูตรจริงแทนได้)
    const scanned = await scanSymbols(batch);

    // 4) merge to data/signals.json
    const merged = await mergeAndWriteSignals({
      group, updatedAt: new Date().toISOString(), results: scanned
    });

    const nextCursor = end < symbols.length ? end : null;

    res.status(200).json({
      ok: true,
      version: "r13",
      group,
      total: symbols.length,
      processed: scanned.length,
      start,
      end: end - 1,
      nextCursor,
      batchSize,
      savedPreview: merged
    });
  } catch (e) {
    console.error("run-scan failed:", e);
    res.status(500).json({ error: "scan failed", detail: String(e) });
  }
}

/* ======================= Indicator hooks (mock) ======================= */
async function compute1D(ticker){ return "Sell"; }
async function compute1W(ticker){ return "Sell"; }

async function scanSymbols(list){
  const out = [];
  for (const t of list){
    const [d,w] = await Promise.all([compute1D(t), compute1W(t)]);
    out.push({ ticker: t, signalD: d || "-", signalW: w || "-", price: null, timeframe: "1D" });
  }
  return out;
}

/* ======================== Symbol sources (live) ======================= */
async function getSymbols(group){
  switch (group){
    case "sp500":          return await sp500();            // 500
    case "nasdaq100":      return await nas100();           // 100
    case "altcoins":       return await okxAltTop100();     // 100 alt
    case "binance_top200": return await binanceTopUSDT(200);// 200
    case "okx_top200":     return await okxTopUSDT(200);    // 200
    case "bitkub":         return await bitkubTHB();        // ทุกคู่ THB
    case "set50":          return await setIndex("set50");  // 50
    case "set100":         return await setIndex("set100"); // 100 (บางที wiki หล่นเล็กน้อย)
    case "etfs":           return curatedETFs();
    case "gold":           return ["GC=F","XAUUSD=X"];
    default:               return [];
  }
}

/* ---- S&P500 (ต้อง 500) ---- */
async function sp500(){
  return await pickFirst([
    async ()=> fromDataHubSP500(500),
    async ()=> fromGitHubSP500(500),
    async ()=> fromSlickchartsSP500(500)
  ], 500);
}
async function fromDataHubSP500(n){
  const r = await fetchT("https://datahub.io/core/s-and-p-500-companies/r/constituents.json");
  if (!r.ok) throw new Error("datahub sp500 "+r.status);
  const js = await r.json();
  const arr = js.map(x=>String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
  if (arr.length<n) throw new Error("datahub too small");
  return arr.slice(0,n);
}
async function fromGitHubSP500(n){
  const r = await fetchT("https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.json");
  if (!r.ok) throw new Error("github sp500 "+r.status);
  const js = await r.json();
  const arr = js.map(x=>String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
  if (arr.length<n) throw new Error("github too small");
  return arr.slice(0,n);
}
async function fromSlickchartsSP500(n){
  const r = await fetchT("https://r.jina.ai/http://www.slickcharts.com/sp500"); // proxy snapshot
  if (!r.ok) throw new Error("slickcharts "+r.status);
  const h = await r.text();
  const set = new Set(); let m;
  const re = /<td[^>]*class="text-center"[^>]*>\s*([A-Z.\-]{1,7})\s*<\/td>/g;
  while ((m = re.exec(h))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set);
  if (arr.length<n) throw new Error("slick parse small");
  return arr.slice(0,n);
}

/* ---- Nasdaq100 (ต้อง 100) ---- */
async function nas100(){
  return await pickFirst([
    async ()=> fromWikipediaNas100(100),
    async ()=> fromGitHubNas100(100)
  ], 100);
}
async function fromWikipediaNas100(n){
  const r = await fetchT("https://r.jina.ai/http://en.wikipedia.org/wiki/Nasdaq-100");
  if (!r.ok) throw new Error("wiki nas "+r.status);
  const h = await r.text();
  const set = new Set(); let m;
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  while ((m = re.exec(h))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set).filter(x=>/^[A-Z\-]+$/.test(x));
  if (arr.length<n) throw new Error("nas small");
  return arr.slice(0,n);
}
async function fromGitHubNas100(n){
  const r = await fetchT("https://raw.githubusercontent.com/tonybenoy/nasdaq-100-list/main/nasdaq_100_list.json");
  if (!r.ok) throw new Error("github nas "+r.status);
  const js = await r.json();
  const arr = (js?.tickers||js||[]).map(s=>String(s||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
  if (arr.length<n) throw new Error("github nas small");
  return arr.slice(0,n);
}

/* ---- SET50/SET100 ---- */
async function setIndex(which){
  const need = which==="set50" ? 50 : 100;
  const r = await fetchT(`https://r.jina.ai/http://en.wikipedia.org/wiki/${which==="set50"?"SET50_Index":"SET100_Index"}`);
  if (!r.ok) throw new Error("wiki "+which+" "+r.status);
  const h = await r.text();
  const set = new Set(); let m;
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  while ((m = re.exec(h))) set.add(m[1].toUpperCase());
  const arr = Array.from(set).filter(x=>/^[A-Z0-9]{2,6}$/.test(x));
  if (arr.length < need-5) throw new Error(which+" small");
  return arr.slice(0,need);
}

/* ---- Bitkub ทุกคู่ THB ---- */
async function bitkubTHB(){
  const r = await fetchT("https://api.bitkub.com/api/market/symbols");
  if (!r.ok) throw new Error("bitkub "+r.status);
  const js = await r.json();
  const out = [];
  for (const it of js?.result||[]){
    const raw = String(it.symbol||""); // THB_BTC
    const [fiat,coin] = raw.split("_");
    if (fiat==="THB" && coin) out.push(`${coin}_THB`);
  }
  return uniq(out).sort();
}

/* ---- OKX/Binance USDT (by quote volume) ---- */
async function okxTopUSDT(topN){
  const r = await fetchT("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
  if (!r.ok) throw new Error("okx "+r.status);
  const js = await r.json();
  const rows = (js?.data||[])
    .filter(x => String(x.instId).endsWith("-USDT"))
    .map(x => ({ sym: String(x.instId||"").replace("-","").toUpperCase(), vol: Number(x.volCcy||0) }))
    .sort((a,b)=>b.vol-a.vol)
    .slice(0, topN)
    .map(x => x.sym);
  if (rows.length < Math.min(150, topN)) throw new Error("okx insufficient");
  return rows;
}
async function binanceTopUSDT(topN){
  const r = await fetchT("https://api.binance.com/api/v3/ticker/24hr");
  if (!r.ok) throw new Error("binance "+r.status);
  const js = await r.json();
  const rows = js
    .filter(x => String(x.symbol).endsWith("USDT"))
    .map(x => ({ sym: x.symbol.toUpperCase(), vol: Number(x.quoteVolume||0) }))
    .sort((a,b)=>b.vol-a.vol)
    .slice(0, topN)
    .map(x => x.sym);
  if (rows.length < Math.min(150, topN)) throw new Error("binance insufficient");
  return rows;
}

/* ---- OKX Alt top100 (ตัด BTC/ETH + stable ออก) ---- */
async function okxAltTop100(){
  const full = await okxTopUSDT(250);
  const STABLE = new Set(["USDT","USDC","DAI","BUSD","FDUSD","TUSD","UST","EURS","EURT"]);
  const alts = full.filter(sym=>{
    if (sym==="BTCUSDT" || sym==="ETHUSDT") return false;
    const base = sym.replace(/USDT$/,"");
    return !STABLE.has(base);
  });
  return alts.slice(0,100);
}

/* ---- Curated ETFs (รวมรายการที่ขอเพิ่ม) ---- */
function curatedETFs(){
  return [
    "JEPQ","SCHD","QQQ","SPY","VOO","O","IVV","MSTY",
    "DIA","IWM","EEM","GLD","XLK","XLF","XLE","XLV","ARKK","TLT","HYG","SMH",
    "XLY","XLP","XLC","XLB","XLI","IYR","VNQ","VTV","VUG","VTI","VO","VB",
    "VEA","VWO","BND","AGG","LQD","IAU","SLV","URA","XOP","XME","KRE","KBE",
    "SOXX","EFA","EWJ","EWT"
  ];
}

/* ============================ GitHub I/O ============================ */
async function ghReadJSON(path, repo, branch) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op: "read", path, repo: repo||"", branch: branch||"" }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetchT(url);
  if (!r.ok) throw new Error(`ghRead ${r.status} ${await r.text()}`);
  return r.json();
}
async function ghWrite(path, repo, branch, content, message) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op: "write", path, repo: repo||"", branch: branch||"" }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetchT(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, message })
  });
  if (!r.ok) throw new Error(`ghWrite ${r.status} ${await r.text()}`);
  return r.json();
}
async function mergeAndWriteSignals(payload) {
  const repo   = process.env.GH_REPO || process.env.GH_REPO_SYMBOLS;
  const branch = process.env.GH_BRANCH || "main";
  const path   = process.env.GH_PATH_SIGNALS || "data/signals.json";

  let prev = {};
  try { prev = await ghReadJSON(path, repo, branch); } catch {}

  const map = new Map();
  if (prev?.group === payload.group && Array.isArray(prev?.results)) {
    for (const r of prev.results) map.set(r.ticker, r);
  }
  for (const r of payload.results) map.set(r.ticker, r);

  const merged = { group: payload.group, updatedAt: payload.updatedAt, results: Array.from(map.values()) };
  await ghWrite(path, repo, branch, JSON.stringify(merged, null, 2), `update data/signals.json (${payload.group})`);
  return merged;
}

/* ================================ Utils =============================== */
function isTrue(v){ return ["1","true","yes","on"].includes(String(v||"").toLowerCase()); }
function clampInt(v,min,max,def){ const n=parseInt(v??"",10); return Number.isFinite(n)?Math.max(min,Math.min(max,n)):def; }
function uniq(arr){ return Array.from(new Set((arr||[]).map(s=>String(s||"").trim()).filter(Boolean))); }
async function fetchT(url, init={}){
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      ...init, signal: ctrl.signal,
      headers: { "User-Agent":"signal-dashboard/1.0", ...(init.headers||{}) }
    });
    return r;
  } finally { clearTimeout(t); }
}
async function pickFirst(providers, need){
  for (const fn of providers){
    try {
      const a = await fn();
      if (a?.length >= need) return a.slice(0,need);
    } catch(e){ console.warn("provider failed:", fn.name, e?.message||e); }
  }
  return [];
}
