// api/run-scan.js
// Batch scan + live symbol sources (Node runtime) + robust fallbacks + 1D/1W hooks

// สำคัญสุด: บังคับให้ใช้ Node.js runtime (ไม่ใช่ Edge) เพื่อให้ fetch ออก internet ได้ครบ
export const config = { runtime: "nodejs" };

const LIVE_DEFAULT = true;
const DEF_BATCH = 50;
const MAX_BATCH = 200;
const REQ_TIMEOUT_MS = 15000;

/* ============================== Handler ============================== */
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group   = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual  = ["1","true","yes"].includes((url.searchParams.get("manual")||"").toLowerCase());
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, MAX_BATCH, DEF_BATCH);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);
    const forceLive = LIVE_DEFAULT || ["1","true","yes"].includes((url.searchParams.get("live")||"").toLowerCase());

    const allSymbols = await getSymbolsForGroup(group, forceLive);
    if (!allSymbols.length) return res.status(400).json({ error: `no symbols for group "${group}"` });

    const start = isManual ? cursor : 0;
    const end   = isManual ? Math.min(start + batchSize, allSymbols.length) : Math.min(batchSize, allSymbols.length);
    const batch = allSymbols.slice(start, end);

    const scanned = await scanSymbols(batch);

    const mergedPayload = await mergeAndWriteSignals({
      group, updatedAt: new Date().toISOString(), results: scanned
    });

    const nextCursor = end < allSymbols.length ? end : null;

    return res.status(200).json({
      ok: true,
      version: "r12-node",
      group,
      total: allSymbols.length,
      processed: scanned.length,
      start,
      end: end - 1,
      nextCursor,
      batchSize,
      savedCount: mergedPayload.results?.length || 0,
      savedPreview: mergedPayload
    });

  } catch (err) {
    console.error("run-scan error:", err);
    return res.status(500).json({ error: "scan failed", detail: String(err) });
  }
}

/* ====================== Indicator hooks (1D/1W) ====================== */
/* ใส่สูตรจริงของคุณแทนได้เลย */
async function computeIndicatorD(ticker) { return "Sell"; }
async function computeIndicatorW(ticker) { return "Sell"; }

async function scanSymbols(symbols) {
  const out = [];
  for (const ticker of symbols) {
    const [d,w] = await Promise.all([ computeIndicatorD(ticker), computeIndicatorW(ticker) ]);
    out.push({ ticker, signalD: d || "-", signalW: w || "-", price: null, timeframe: "1D" });
  }
  return out;
}

/* ====================== Get symbols (live + fallback) ===================== */
async function getSymbolsForGroup(group, preferLive=true) {
  let arr = [];
  if (preferLive) {
    try {
      arr = await getSymbolsLive(group);
      if (arr?.length) return uniq(arr);
    } catch (e) {
      console.warn(`[live] ${group} failed:`, e?.message||e);
    }
  }

  // curated (เฉพาะ ETFs ที่ขอเพิ่ม)
  try {
    arr = await getSymbolsCurated(group);
    if (arr?.length) return uniq(arr);
  } catch {}

  // fallback ไฟล์ใน repo (สุดท้ายจริง ๆ)
  try {
    const json = await ghReadJSON(
      process.env.GH_PATH_SYMBOLS || "data/symbols.json",
      process.env.GH_REPO_SYMBOLS || process.env.GH_REPO,
      process.env.GH_BRANCH || "main"
    );
    return uniq(Array.isArray(json?.[group]) ? json[group] : []);
  } catch (e2) {
    console.warn(`[file-fallback] ${group} failed:`, e2?.message || e2);
    return [];
  }
}

async function getSymbolsLive(group) {
  switch (group) {
    case "sp500":
      // ต้องได้ 500 เสมอ: DataHub → slickcharts → GitHub mirror
      return await chainFirst([
        fetchSP500_DataHub,
        fetchSP500_Slickcharts,
        fetchSP500_GitHubMirror
      ], requiresAtLeast(500));

    case "nasdaq100":
      // ต้องได้ 100 เสมอ: Wikipedia → GitHub mirror
      return await chainFirst([
        fetchNasdaq100_Wikipedia,
        fetchNasdaq100_GitHubMirror
      ], requiresAtLeast(100));

    case "bitkub":
      return await fetchBitkub_THD_Pairs(); // ปกติ 200+ รายการ

    case "set50":
      return await chainFirst([() => fetchSET_Wikipedia("set50")], requiresAtLeast(49));

    case "set100":
      return await chainFirst([() => fetchSET_Wikipedia("set100")], requiresAtLeast(90)); // Wikipedia บางทีขาด ให้ดึงได้เยอะที่สุด

    case "altcoins":
      // เอา top 100 จาก OKX (USDT spot)
      return await chainFirst([() => fetchOKX_TopUSDT(100)], requiresAtLeast(80));

    case "binance_top200":
      return await chainFirst([() => fetchBinance_TopUSDT(200)], requiresAtLeast(150));

    case "okx_top200":
      return await chainFirst([() => fetchOKX_TopUSDT(200)], requiresAtLeast(150));

    case "etfs":
      return curatedETFs();

    case "gold":
      return ["GC=F","XAUUSD=X"];

    default:
      return [];
  }
}

/* ============================= Sources ============================== */
// helper fetch with timeout + UA
async function fetchT(url, init={}) {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "User-Agent": "signal-dashboard/1.0 (+vercel-node)",
        ...(init.headers||{})
      }
    });
    return r;
  } finally { clearTimeout(t); }
}

function requiresAtLeast(n){ return (arr)=> (arr && arr.length >= n) ? arr.slice(0,n) : null; }
async function chainFirst(fns, validator){
  for (const fn of fns){
    try {
      const got = await fn();
      const ok  = validator ? validator(got) : (got?.length ? got : null);
      if (ok) return ok;
    } catch(e){
      console.warn("source failed:", fn.name, e?.message||e);
    }
  }
  return [];
}

/* ---- S&P500 ---- */
async function fetchSP500_DataHub() {
  const r = await fetchT("https://datahub.io/core/s-and-p-500-companies/r/constituents.json");
  if (!r.ok) throw new Error(`datahub ${r.status}`);
  const js = await r.json();
  const list = js.map(x => String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
  if (list.length < 400) throw new Error("datahub size too small");
  return list.slice(0,500);
}
async function fetchSP500_Slickcharts() {
  const r = await fetchT("https://www.slickcharts.com/sp500");
  if (!r.ok) throw new Error(`slickcharts ${r.status}`);
  const html = await r.text();
  const re = /<td[^>]*class="text-center"[^>]*>\s*([A-Z.\-]{1,7})\s*<\/td>/g;
  const out = new Set(); let m;
  while ((m = re.exec(html))) out.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(out);
  if (arr.length < 400) throw new Error("slickcharts parse too small");
  return arr.slice(0,500);
}
async function fetchSP500_GitHubMirror(){
  const r = await fetchT("https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.json");
  if (!r.ok) throw new Error(`github-mirror ${r.status}`);
  const js = await r.json();
  const list = js.map(x => String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
  if (list.length < 400) throw new Error("github mirror too small");
  return list.slice(0,500);
}

/* ---- Nasdaq100 ---- */
async function fetchNasdaq100_Wikipedia() {
  const r = await fetchT("https://en.wikipedia.org/wiki/Nasdaq-100");
  if (!r.ok) throw new Error(`nas100 wiki ${r.status}`);
  const html = await r.text();
  const set = new Set();
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set).filter(x => /^[A-Z\-]+$/.test(x));
  if (arr.length < 80) throw new Error("nas100 parse small");
  return arr.slice(0,100);
}
async function fetchNasdaq100_GitHubMirror(){
  const r = await fetchT("https://raw.githubusercontent.com/tonybenoy/nasdaq-100-list/main/nasdaq_100_list.json");
  if (!r.ok) throw new Error(`nas100 mirror ${r.status}`);
  const js = await r.json();
  const list = (js?.tickers||js||[]).map(s => String(s||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
  if (list.length < 80) throw new Error("nas100 mirror small");
  return list.slice(0,100);
}

/* ---- SET50 / SET100 ---- */
async function fetchSET_Wikipedia(which) {
  const page = which === "set50" ? "SET50_Index" : "SET100_Index";
  const r = await fetchT(`https://en.wikipedia.org/wiki/${page}`);
  if (!r.ok) throw new Error(`${which} wiki ${r.status}`);
  const html = await r.text();
  const set = new Set();
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase());
  let arr = Array.from(set).filter(x => /^[A-Z0-9]{2,6}$/.test(x));
  const need = (which==="set50") ? 50 : 100;
  if (arr.length < need-10) throw new Error(`${which} parse small`);
  return arr.slice(0, need);
}

/* ---- Bitkub (ทุกคู่ THB) ---- */
async function fetchBitkub_THD_Pairs() {
  const r = await fetchT("https://api.bitkub.com/api/market/symbols");
  if (!r.ok) throw new Error(`bitkub ${r.status}`);
  const js = await r.json();
  const out = [];
  for (const it of js?.result || []) {
    const raw = String(it.symbol || ""); // "THB_BTC"
    const [fiat, coin] = raw.split("_");
    if (fiat === "THB" && coin) out.push(`${coin}_THB`);
  }
  const arr = uniq(out).sort();
  if (!arr.length) throw new Error("bitkub empty");
  return arr;
}

/* ---- Binance / OKX USDT ---- */
async function fetchBinance_TopUSDT(topN) {
  const r = await fetchT("https://api.binance.com/api/v3/ticker/24hr");
  if (!r.ok) throw new Error(`binance ${r.status}`);
  const js = await r.json();
  const rows = js
    .filter(x => String(x.symbol).endsWith("USDT"))
    .map(x => ({ sym: x.symbol, vol: Number(x.quoteVolume||0) }))
    .sort((a,b)=>b.vol-a.vol)
    .slice(0, topN)
    .map(x => x.sym.toUpperCase());
  if (rows.length < Math.min(50, topN/2)) throw new Error("binance insufficient");
  return rows;
}
async function fetchOKX_TopUSDT(topN) {
  const r = await fetchT("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
  if (!r.ok) throw new Error(`okx ${r.status}`);
  const js = await r.json();
  const rows = (js?.data||[])
    .filter(x => String(x.instId).endsWith("-USDT"))
    .map(x => ({ sym: String(x.instId||"").replace("-",""), vol: Number(x.volCcy||0) }))
    .sort((a,b)=>b.vol-a.vol)
    .slice(0, topN)
    .map(x => x.sym.toUpperCase());
  if (rows.length < Math.min(50, topN/2)) throw new Error("okx insufficient");
  return rows;
}

/* ---- Curated (ETFs) ---- */
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
    method: "POST", headers: { "Content-Type": "application/json" },
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

  let m = new Map();
  if (prev?.group === payload.group && Array.isArray(prev?.results)) {
    for (const r of prev.results) m.set(r.ticker, r);
  }
  for (const r of payload.results) m.set(r.ticker, r);

  const merged = { group: payload.group, updatedAt: payload.updatedAt, results: Array.from(m.values()) };
  await ghWrite(path, repo, branch, JSON.stringify(merged, null, 2), `update data/signals.json (${payload.group})`);
  return merged;
}

/* ================================ Utils =============================== */
function clampInt(v, min, max, def) {
  const n = parseInt(v ?? "", 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}
const uniq = arr => Array.from(new Set((arr||[]).map(s => String(s||"").trim()).filter(Boolean)));
