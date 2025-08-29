// api/run-scan.js
// Batch scan + live symbol sources + merge & write signals.json

/* ============================== Utils =============================== */
const UA = () => ({ headers: { "User-Agent": "signal-dashboard/1.0" } });

function clampInt(v, min, max, def) {
  const n = parseInt(v ?? "", 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}
const uniq = arr =>
  Array.from(new Set((arr || []).map(s => String(s || "").trim()).filter(Boolean)));

/* ============================ GitHub I/O ============================ */
async function ghReadJSON(path, repo, branch) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({
    op: "read",
    path,
    repo: repo || "",
    branch: branch || ""
  }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ghRead ${r.status} ${await r.text()}`);
  return r.json();
}

async function ghWrite(path, repo, branch, content, message) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({
    op: "write",
    path,
    repo: repo || "",
    branch: branch || ""
  }).toString();
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
 * รวมผลเดิมกับผลใหม่ของ "กลุ่มเดียวกัน" (key = ticker) แล้วเขียนกลับ
 */
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

  const merged = {
    group: payload.group,
    updatedAt: payload.updatedAt,
    results: Array.from(map.values())
  };

  await ghWrite(path, repo, branch, JSON.stringify(merged, null, 2), `update signals ${payload.group}`);
  return merged;
}

/* ============================== Scanner ============================= */
/** ใส่ logic อินดิเคเตอร์จริงของคุณได้ที่นี่ */
async function scanSymbols(symbols) {
  // placeholder: 1D = "Sell", 1W = "-" (แก้ตามอินดิเคเตอร์จริงได้เลย)
  return symbols.map(ticker => ({
    ticker,
    signalD: "Sell",
    signalW: "-",
    price: null,
    timeframe: "1D"
  }));
}

/* ===================== Live Symbols (หลัก/สำรอง) ==================== */
async function getSymbolsLive(group) {
  switch (group) {
    case "sp500":
      // หลัก: slickcharts, สำรอง: datahub
      return await fetchSP500Slickcharts().catch(async () => await fetchSP500Datahub());
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
      return ["SPY","QQQ","VTI","DIA","ARKK","IWM","EEM","GLD","XLK","XLF",
              "XLY","XLP","XLE","XLB","XLV","XLU","XLI","XLC","VNQ","LQD",
              "HYG","TIP","SHY","IEF","TLT","SMH","SOXX","KRE","KBE","XME",
              "ITA","XOP","KWEB","EFA","EEMV","SCHD","JEPI","VUG","VTV","VOO",
              "VT","VEA","VWO","VGT","IYR","XRT","XHB","XAR"];
    case "gold":
      return ["GC=F","XAUUSD=X"]; // Futures + Spot
    default:
      return [];
  }
}

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

// S&P500: slickcharts (หลัก)
async function fetchSP500Slickcharts() {
  const url = "https://www.slickcharts.com/sp500";
  const html = await (await fetch(url, UA())).text();
  const re = /<td class="text-center">([A-Z.\-]{1,7})<\/td>/g;
  const out = new Set(); let m;
  while ((m = re.exec(html))) out.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(out);
  if (arr.length < 400) throw new Error("slickcharts parse too small");
  return arr.slice(0, 500);
}
// S&P500: datahub (สำรอง)
async function fetchSP500Datahub() {
  const url = "https://datahub.io/core/s-and-p-500-companies/r/constituents.json";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`datahub ${r.status}`);
  const js = await r.json();
  return js.map(x => String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
}
// Nasdaq 100: Wikipedia
async function fetchNasdaq100Wikipedia() {
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set).filter(x => /^[A-Z\-]+$/.test(x));
  if (arr.length < 80) throw new Error("nas100 parse small");
  return arr.slice(0, 100);
}
// SET50 / SET100: Wikipedia
async function fetchSETWikipedia(which) {
  const page = which === "set50" ? "SET50_Index" : "SET100_Index";
  const url = `https://en.wikipedia.org/wiki/${page}`;
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase());
  let arr = Array.from(set).filter(x => /^[A-Z]{2,6}$/.test(x));
  if (which === "set50"  && arr.length < 40) throw new Error("set50 parse small");
  if (which === "set100" && arr.length < 80) throw new Error("set100 parse small");
  return arr.slice(0, which === "set50" ? 50 : 100);
}
// Bitkub: ทุกคู่ THB_*
async function fetchBitkubTHB() {
  const url = "https://api.bitkub.com/api/market/symbols";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`bitkub ${r.status}`);
  const js = await r.json();
  const out = [];
  for (const it of js?.result || []) {
    const raw = String(it.symbol || ""); // THB_BTC
    const [fiat, coin] = raw.split("_");
    if (fiat === "THB" && coin) out.push(`${coin}_THB`);
  }
  return uniq(out).sort();
}

/* ============== Defaults (crypto quick start – ปรับได้) ============== */
function defaultAltcoins() {
  return [
    "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT","MATICUSDT",
    "DOGEUSDT","DOTUSDT","LINKUSDT","ATOMUSDT","AVAXUSDT","ARBUSDT",
    "OPUSDT","SUIUSDT","APTUSDT","NEARUSDT","FILUSDT","TONUSDT",
    "BCHUSDT","LTCUSDT"
  ];
}
function defaultOKX()      { return defaultAltcoins(); }
function defaultBinance()  { return defaultAltcoins(); }

/* ============================== Handler ============================= */
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual  = ["1","true","yes"].includes((url.searchParams.get("manual")||"").toLowerCase());
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, 200, 50);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);

    // 1) รายชื่อ (สดก่อน → ถ้าพลาดค่อย fallback)
    const allSymbols = await getSymbolsForGroupLiveOrFallback(group);
    if (!allSymbols.length) return res.status(400).json({ error: `no symbols for group "${group}"` });

    // 2) ตัด batch
    const start = isManual ? cursor : 0;
    const end   = isManual ? Math.min(start + batchSize, allSymbols.length)
                           : Math.min(batchSize, allSymbols.length);
    const batch = allSymbols.slice(start, end);

    // 3) สแกน
    const scanned = await scanSymbols(batch);

    // 4) รวม + เขียนกลับ
    const mergedPayload = await mergeAndWriteSignals({
      group,
      updatedAt: new Date().toISOString(),
      results: scanned
    });

    const nextCursor = end < allSymbols.length ? end : null;

    return res.status(200).json({
      ok: true,
      group,
      total: allSymbols.length,
      processed: scanned.length,
      start,
      end: end - 1,
      nextCursor,
      batchSize,
      results: scanned,
      savedPreview: mergedPayload
    });
  } catch (err) {
    console.error("run-scan error:", err);
    return res.status(500).json({ error: "scan failed", detail: String(err) });
  }
}
