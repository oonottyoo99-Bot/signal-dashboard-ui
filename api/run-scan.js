// api/run-scan.js
// Batch scan + live symbol sources + robust fallbacks + 1D/1W hooks

const LIVE_DEFAULT = true;       // บังคับ live โดยดีฟอลต์ (เปิดไว้ให้)
const DEF_BATCH = 50;            // batch เริ่มต้น (UI จะใส่ 100 ให้ sp500/binance/okx อยู่แล้ว)
const MAX_BATCH = 200;

// ----------------------- Main handler -----------------------
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group   = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual  = ["1","true","yes"].includes((url.searchParams.get("manual")||"").toLowerCase());
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, MAX_BATCH, DEF_BATCH);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);
    const forceLive = LIVE_DEFAULT || ["1","true","yes"].includes((url.searchParams.get("live")||"").toLowerCase());

    // 1) load symbols (live -> fallback -> file)
    const allSymbols = await getSymbolsForGroup(group, forceLive);
    if (!allSymbols.length) return res.status(400).json({ error: `no symbols for group "${group}"` });

    // 2) slice batch (manual จะต่อคิวทีละช่วง)
    const start = isManual ? cursor : 0;
    const end   = isManual ? Math.min(start + batchSize, allSymbols.length) : Math.min(batchSize, allSymbols.length);
    const batch = allSymbols.slice(start, end);

    // 3) scan indicators (ใส่สูตรจริงที่ computeIndicatorD/W)
    const scanned = await scanSymbols(batch);

    // 4) merge to data/signals.json (append/replace by ticker)
    const mergedPayload = await mergeAndWriteSignals({
      group, updatedAt: new Date().toISOString(), results: scanned
    });

    const nextCursor = end < allSymbols.length ? end : null;

    return res.status(200).json({
      ok: true,
      version: "r10",
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

/* ======================= Scanner / Indicators ======================= */
// ใส่สูตรอินดิเคเตอร์ของคุณที่สองฟังก์ชันนี้ได้เลย
async function computeIndicatorD(ticker) {
  // TODO: แทนที่ด้วยสูตรจริงของคุณ เช่น MA cross / RSI ฯลฯ (timeframe 1D)
  return "Sell";                  // ชั่วคราว
}
async function computeIndicatorW(ticker) {
  // TODO: แทนที่ด้วยสูตรจริงของคุณ (timeframe 1W) — ตอนนี้ให้ค่าเดียวกับ 1D เพื่อ “มีค่า” ให้โชว์
  const d = await computeIndicatorD(ticker);
  return d;                       // ชั่วคราว: ใช้ค่าเดียวกันก่อน เพื่อให้ช่อง 1W แสดงผล
}

async function scanSymbols(symbols) {
  const out = [];
  for (const ticker of symbols) {
    const [d,w] = await Promise.all([ computeIndicatorD(ticker), computeIndicatorW(ticker) ]);
    out.push({
      ticker,
      signalD: d || "-",
      signalW: w || "-",
      price: null,
      timeframe: "1D"
    });
  }
  return out;
}

/* ==================== Symbol sources (live + fallback) ==================== */

async function getSymbolsForGroup(group, preferLive=true) {
  // ลำดับ: live (หลายแหล่ง) → curated fallback → file JSON
  let arr = [];
  if (preferLive) {
    try {
      arr = await getSymbolsLive(group);
      if (arr?.length) return uniq(arr);
    } catch (e) {
      console.warn(`[live] ${group} failed:`, e?.message||e);
    }
  }
  // curated fallback
  try {
    arr = await getSymbolsCurated(group);
    if (arr?.length) return uniq(arr);
  } catch(e){ /* ignore */ }

  // file fallback (data/symbols.json) — เผื่อฉุกเฉิน
  try {
    const json = await ghReadJSON(
      process.env.GH_PATH_SYMBOLS || "data/symbols.json",
      process.env.GH_REPO_SYMBOLS || process.env.GH_REPO,
      process.env.GH_BRANCH || "main"
    );
    return uniq(Array.isArray(json?.[group]) ? json[group] : []);
  } catch (e2) {
    console.warn(`[file-fallback] ${group} failed:`, e2?.message||e2);
    return [];
  }
}

async function getSymbolsLive(group) {
  switch (group) {
    case "sp500":
      // ใช้ DataHub เป็นหลัก (ครบ 500), สำรอง Slickcharts
      try { return await fetchSP500_DataHub(); }
      catch { return await fetchSP500_Slickcharts(); }

    case "nasdaq100":
      // Wikipedia ปัจจุบันเสถียรสุดแบบไม่ auth
      return await fetchNasdaq100_Wikipedia();

    case "bitkub":
      return await fetchBitkub_THD_Pairs();

    case "set50":
      return await fetchSET_Wikipedia("set50");         // 50 ตัว

    case "set100":
      return await fetchSET_Wikipedia("set100");        // 100 ตัว

    case "altcoins":
      // OKX USDT spot → sort by 24h volume → top 100
      return await fetchOKX_TopUSDT(100);

    case "binance_top200":
      // Binance USDT spot → sort by quoteVolume → top 200
      return await fetchBinance_TopUSDT(200);

    case "okx_top200":
      // OKX USDT spot → top 200
      return await fetchOKX_TopUSDT(200);

    case "etfs":
      return curatedETFs();

    case "gold":
      return ["GC=F","XAUUSD=X"];

    default:
      return [];
  }
}

/* ---------------- S&P500 ---------------- */
async function fetchSP500_DataHub() {
  const url = "https://datahub.io/core/s-and-p-500-companies/r/constituents.json";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`datahub ${r.status}`);
  const js = await r.json();
  const list = js.map(x => String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
  if (list.length < 400) throw new Error("datahub size too small");
  return list.slice(0,500);
}
async function fetchSP500_Slickcharts() {
  const url = "https://www.slickcharts.com/sp500";
  const html = await (await fetch(url, UA())).text();
  // ดึงจากคอลัมน์ Symbol ในตาราง
  const re = /<td[^>]*class="text-center"[^>]*>\s*([A-Z.\-]{1,7})\s*<\/td>/g;
  const out = new Set(); let m;
  while ((m = re.exec(html))) out.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(out);
  if (arr.length < 400) throw new Error("slickcharts parse too small");
  return arr.slice(0,500);
}

/* ---------------- Nasdaq100 ---------------- */
async function fetchNasdaq100_Wikipedia() {
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, UA())).text();
  // Wikipedia มีหลายตาราง ใช้ regex เก็บสัญลักษณ์ในคอลัมน์แรก/สอง
  const set = new Set();
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set).filter(x => /^[A-Z\-]+$/.test(x));
  if (arr.length < 80) throw new Error("nas100 parse small");
  return arr.slice(0,100);
}

/* ---------------- SET50 / SET100 ---------------- */
async function fetchSET_Wikipedia(which) {
  const page = which === "set50" ? "SET50_Index" : "SET100_Index";
  const url = `https://en.wikipedia.org/wiki/${page}`;
  const html = await (await fetch(url, UA())).text();
  // ตัวย่อหุ้นไทยเป็น A-Z/ตัวเลข 2-6 ตัว (ไม่ใช่ชื่อบริษัท)
  const set = new Set();
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase());
  const arr = Array.from(set).filter(x => /^[A-Z0-9]{2,6}$/.test(x));
  const need = (which==="set50") ? 50 : 100;
  if (arr.length < need-10) throw new Error(`${which} parse small`);
  return arr.slice(0, need);
}

/* ---------------- Bitkub (ทุกคู่ THB) ---------------- */
async function fetchBitkub_THD_Pairs() {
  const url = "https://api.bitkub.com/api/market/symbols";
  const r = await fetch(url, UA());
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

/* ---------------- Binance Top USDT ---------------- */
async function fetchBinance_TopUSDT(topN) {
  // ดึง 24hr tickers แล้วกรองคู่ *USDT เฉพาะ spot
  const url = "https://api.binance.com/api/v3/ticker/24hr";
  const r = await fetch(url, UA());
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

/* ---------------- OKX Top USDT ---------------- */
async function fetchOKX_TopUSDT(topN) {
  // ดึง tickers ทั้งหมด → กรองคู่ฝั่ง quote=USDT → เรียงตาม volCcy แล้วตัด topN
  // เอกสาร: https://www.okx.com/api/v5/market/tickers?instType=SPOT
  const url = "https://www.okx.com/api/v5/market/tickers?instType=SPOT";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`okx ${r.status}`);
  const js = await r.json();
  const rows = (js?.data||[])
    .filter(x => String(x.instId).endsWith("-USDT"))   // รูป "ADA-USDT"
    .map(x => ({ sym: String(x.instId||"").replace("-","")+"", vol: Number(x.volCcy||0) }))
    .sort((a,b)=>b.vol-a.vol)
    .slice(0, topN)
    .map(x => x.sym.toUpperCase());
  if (rows.length < Math.min(50, topN/2)) throw new Error("okx insufficient");
  return rows;
}

/* ---------------- Curated fallback (ขั้นต่ำให้ครบ) ---------------- */
function getSymbolsCurated(group) {
  switch(group){
    case "etfs":
      // เพิ่มตามที่คุณขอ: JEPQ / SCHD / QQQ / SPY / VOO / O / IVV / MSTY
      return Promise.resolve(["JEPQ","SCHD","QQQ","SPY","VOO","O","IVV","MSTY",
        "DIA","IWM","EEM","GLD","XLK","XLF","XLE","XLV","ARKK","TLT","HYG","SMH",
        "XLY","XLP","XLC","XLB","XLI","IYR","VNQ","VTV","VUG","VTI","VO","VB",
        "VEA","VWO","BND","AGG","LQD","IAU","SLV","URA","XOP","XME","KRE","KBE",
        "SOXX","EFA","EWJ","EWT" // รวมให้ ~50 ตัว
      ]);
    default:
      return Promise.resolve([]);
  }
}

/* ============================ GitHub I/O ============================ */
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
 *  - โหลด signals.json เดิม
 *  - ถ้า group เดิม → รวมผลโดย key = ticker (ข้อมูลใหม่ทับของเก่า)
 *  - เขียนกลับ พร้อม updatedAt ใหม่
 */
async function mergeAndWriteSignals(payload) {
  const repo   = process.env.GH_REPO || process.env.GH_REPO_SYMBOLS;
  const branch = process.env.GH_BRANCH || "main";
  const path   = process.env.GH_PATH_SIGNALS || "data/signals.json";

  let prev = {};
  try {
    prev = await ghReadJSON(path, repo, branch);
  } catch { /* ignore */ }

  let resultsMap = new Map();
  if (prev?.group === payload.group && Array.isArray(prev?.results)) {
    for (const r of prev.results) resultsMap.set(r.ticker, r);
  }

  for (const r of payload.results) resultsMap.set(r.ticker, r);

  const merged = {
    group: payload.group,
    updatedAt: payload.updatedAt,
    results: Array.from(resultsMap.values())
  };

  await ghWrite(path, repo, branch, JSON.stringify(merged, null, 2), `update data/signals.json (${payload.group})`);
  return merged;
}

/* ============================== Utils ============================== */
const UA = () => ({
  headers: { "User-Agent": "signal-dashboard/1.0 (+vercel)" }
});
function clampInt(v, min, max, def) {
  const n = parseInt(v ?? "", 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}
const uniq = arr => Array.from(new Set((arr||[]).map(s => String(s||"").trim()).filter(Boolean)));
