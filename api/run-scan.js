// api/run-scan.js
// Batch scanner with optional server-side chaining + live symbols + merge to signals.json

export default async function handler(req, res) {
  try {
    const url   = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual = ["1","true","yes"].includes((url.searchParams.get("manual")||"").toLowerCase());

    // chain: ให้ API ลูป batch ต่อเองภายในครั้งเดียว
    let wantChain = ["1","true","yes"].includes((url.searchParams.get("chain")||"").toLowerCase());

    // ค่ามาตรฐานแต่ละกลุ่ม (bitkub มีรายการยาว → chain เอง + batch เล็กลง)
    const defaultBatch = group === "bitkub" ? 25 : 50;
    if (group === "bitkub" && isManual && url.searchParams.get("chain") == null) {
      wantChain = true; // เปิด chain อัตโนมัติสำหรับ bitkub
    }

    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, 500, defaultBatch);
    let cursor      = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);

    // โหลดรายชื่อ (สดก่อน, ไม่ได้ค่อย fallback)
    const allSymbols = stableUniq(await getSymbolsForGroupLiveOrFallback(group));
    if (!allSymbols.length) return res.status(400).json({ error: `no symbols for group "${group}"` });

    // ฟังก์ชันสแกนหนึ่งก้อน
    const scanOneBatch = async (start) => {
      const end   = Math.min(start + batchSize, allSymbols.length);
      const batch = allSymbols.slice(start, end);
      const scanned = await scanSymbols(batch);
      const mergedPayload = await mergeAndWriteSignals({
        group,
        updatedAt: new Date().toISOString(),
        results: scanned
      });
      const nextCursor = end < allSymbols.length ? end : null;
      return { scanned, mergedPayload, start, end, nextCursor };
    };

    // โหมดธรรมดา: 1 batch / โหมด chain: ลูปหลาย batch ภายในงบประมาณเวลา
    let totalProcessed = 0;
    let lastMerged = null;
    let iterations = 0;

    const maxLoops = 100;               // กันลูประยะยาว
    const timeBudgetMs = 18_000;        // กัน timeout serverless
    const t0 = Date.now();

    do {
      const { scanned, mergedPayload, start, end, nextCursor } = await scanOneBatch(cursor);
      totalProcessed += scanned.length;
      lastMerged = mergedPayload;
      cursor = nextCursor ?? cursor;
      iterations += 1;

      // เงื่อนไขหยุด
      if (!wantChain) break;
      if (nextCursor == null) break;                 // ครบแล้ว
      if (iterations >= maxLoops) break;             // กันลูปเกิน
      if (Date.now() - t0 > timeBudgetMs) break;     // กันหมดเวลาบัดเจ็ต
    } while (true);

    const endIndex = Math.min(cursor || allSymbols.length, allSymbols.length) - 1;

    return res.status(200).json({
      ok: true,
      group,
      total: allSymbols.length,
      processed: totalProcessed,
      start: isManual ? (cursor ? cursor - totalProcessed : 0) : 0,
      end: endIndex >= 0 ? endIndex : null,
      nextCursor: (cursor != null && cursor < allSymbols.length) ? cursor : null,
      batchSize,
      loops: iterations,
      savedPreview: lastMerged || { group, updatedAt: null, results: [] }
    });
  } catch (err) {
    console.error("run-scan error:", err);
    return res.status(500).json({ error: "scan failed", detail: String(err) });
  }
}

/* ========================= Scanner (แทนที่ด้วยอินดิเคเตอร์จริงได้) ========================= */
// ชั่วคราว: มีค่าแน่นอนทั้ง 1D และ 1W เพื่อให้คอลัมน์แสดงผล
async function scanSymbols(symbols) {
  return symbols.map(ticker => ({
    ticker,
    signalD: "Sell",  // TODO: ใส่ logic อินดิเคเตอร์ 1D จริง
    signalW: "Sell",  // TODO: ใส่ logic อินดิเคเตอร์ 1W จริง
    price: null,
    timeframe: "1D"
  }));
}

/* ============================ Live Symbols (หลัก/สำรอง) ============================ */

async function getSymbolsForGroupLiveOrFallback(group) {
  try {
    const live = await getSymbolsLive(group);
    if (Array.isArray(live) && live.length) return live;
  } catch (e) {
    console.warn(`[symbols-live] ${group} failed:`, e?.message || e);
  }
  try {
    const json = await ghReadJSON(
      process.env.GH_PATH_SYMBOLS || "data/symbols.json",
      process.env.GH_REPO_SYMBOLS || process.env.GH_REPO,
      process.env.GH_BRANCH || "main"
    );
    return Array.isArray(json?.[group]) ? json[group] : [];
  } catch (e2) {
    console.warn(`[symbols-fallback] ${group} failed:`, e2?.message || e2);
    return [];
  }
}

async function getSymbolsLive(group) {
  switch (group) {
    case "sp500":
      return await fetchSP500Wikipedia().catch(fetchSP500Datahub);
    case "nasdaq100":
      return await fetchNasdaq100Wikipedia();
    case "bitkub":
      return await fetchBitkubTHB();
    case "set50":
      return await fetchSETWikipedia("set50");
    case "set100":
      return await fetchSETWikipedia("set100");
    case "altcoins":
      return defaultAltcoins();
    case "okx_top200":
      return defaultOKX();
    case "binance_top200":
      return defaultBinance();
    case "etfs":
      return TOP50_ETFS;
    case "gold":
      return ["GC=F","XAUUSD=X"];
    default:
      return [];
  }
}

/* -------------------------- แหล่งข้อมูลรายชื่อกลุ่มหลัก -------------------------- */

// S&P500 – Wikipedia (500) → ถ้าน้อยกว่า 400 โยน error เพื่อไป Datahub
async function fetchSP500Wikipedia() {
  const url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
  const html = await (await fetch(url, UA())).text();
  const table = html.match(/<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (!table) throw new Error("sp500: table not found");
  const out = [];
  const cell = /<tr[^>]*>\s*<td[^>]*>\s*([A-Z.\-]{1,7})\s*<\/td>/gi;
  let m;
  while ((m = cell.exec(table[0]))) out.push(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = stableUniq(out);
  if (arr.length < 400) throw new Error(`sp500 wikipedia parse too small: ${arr.length}`);
  return arr.slice(0, 500);
}
// S&P500 – Datahub (สำรอง)
async function fetchSP500Datahub() {
  const url = "https://datahub.io/core/s-and-p-500-companies/r/constituents.json";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`datahub ${r.status}`);
  const js = await r.json();
  return stableUniq(js.map(x => String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean));
}

// Nasdaq-100 – Wikipedia (ใช้ title="NASDAQ:XXXX")
async function fetchNasdaq100Wikipedia() {
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  const re = /title="NASDAQ:([A-Z.\-]{1,7})"/g;
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set).filter(x => /^[A-Z\-]+$/.test(x));
  if (arr.length < 90) throw new Error(`nasdaq100 wikipedia parse too small: ${arr.length}`);
  return stableUniq(arr.slice(0, 100));
}

// SET50 / SET100 – Wikipedia
async function fetchSETWikipedia(which) {
  const page = which === "set50" ? "SET50_Index" : "SET100_Index";
  const url = `https://en.wikipedia.org/wiki/${page}`;
  const html = await (await fetch(url, UA())).text();
  const table = html.match(/<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (!table) throw new Error(`${which}: table not found`);
  const set = new Set();
  const cell = /<tr[^>]*>\s*<td[^>]*>\s*([A-Z0-9]{2,6})\s*<\/td>/gi;
  let m; while ((m = cell.exec(table[0]))) set.add(m[1].toUpperCase());
  let arr = Array.from(set).filter(x => /^[A-Z0-9]{2,6}$/.test(x));
  if (which === "set50"  && arr.length < 40) throw new Error("set50 parse small");
  if (which === "set100" && arr.length < 80) throw new Error("set100 parse small");
  return stableUniq(arr.slice(0, which === "set50" ? 50 : 100));
}

// Bitkub – คู่ THB ทั้งหมด
async function fetchBitkubTHB() {
  const url = "https://api.bitkub.com/api/market/symbols";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`bitkub ${r.status}`);
  const js = await r.json();
  const out = [];
  for (const it of js?.result || []) {
    const s = String(it.symbol||"");         // "THB_BTC"
    const [fiat, coin] = s.split("_");
    if (fiat === "THB" && coin) out.push(`${coin}_THB`);
  }
  return stableUniq(out);
}

/* ---------------------------- Defaults / curated ---------------------------- */

function defaultAltcoins () { return [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT","MATICUSDT",
  "DOGEUSDT","DOTUSDT","LINKUSDT","ATOMUSDT","AVAXUSDT","ARBUSDT",
  "OPUSDT","SUIUSDT","APTUSDT","NEARUSDT","FILUSDT","TONUSDT",
  "BCHUSDT","LTCUSDT"
];}
function defaultOKX()     { return defaultAltcoins(); }
function defaultBinance() { return defaultAltcoins(); }

const TOP50_ETFS = [
  "SPY","IVV","VOO","VTI","QQQ","DIA","IWM","EFA","VTV","VUG",
  "AGG","BND","GLD","SLV","XLK","XLF","XLE","XLY","XLI","XLV",
  "XLU","XLP","VNQ","IEMG","VEA","VXUS","HYG","LQD","SHY","TLT",
  "IEF","IAU","SMH","SOXX","ARKK","IYR","VWO","SCHD","JEPI","SPLG",
  "VYM","IWB","IWF","IWD","IWR","IWS","IWP","IWO","IWN","EWJ"
];

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

/** รวมผลเดิม + เขียนกลับ */
async function mergeAndWriteSignals(payload) {
  const repo   = process.env.GH_REPO || process.env.GH_REPO_SYMBOLS;
  const branch = process.env.GH_BRANCH || "main";
  const path   = process.env.GH_PATH_SIGNALS || "data/signals.json";
  let prev = {};
  try { prev = await ghReadJSON(path, repo, branch); } catch {}
  const map = new Map();
  if (prev?.group === payload.group && Array.isArray(prev.results)) {
    for (const r of prev.results) map.set(r.ticker, r);
  }
  for (const r of payload.results) map.set(r.ticker, r);
  const merged = { group: payload.group, updatedAt: payload.updatedAt, results: Array.from(map.values()) };
  await ghWrite(path, repo, branch, JSON.stringify(merged, null, 2), `update signals ${payload.group}`);
  return merged;
}

/* ================================= Utils ================================== */

const UA = () => ({ headers: { "User-Agent": "signal-dashboard/1.0" } });
function clampInt(v, min, max, def) { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def; }
const stableUniq = arr => Array.from(new Set((arr||[]).map(s => String(s||"").trim()).filter(Boolean))).sort();
