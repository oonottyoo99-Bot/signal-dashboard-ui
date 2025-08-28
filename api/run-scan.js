// api/run-scan.js
// Batch scanner + live symbols + append/merge to signals.json (per group)
// ✔ ใช้ req.query (Next.js/Express) ป้องกัน req.url เป็น undefined บนบาง deployment
// ✔ มี timeout ให้ fetch ภายนอก, ส่ง detail error กลับ, fallback ไปไฟล์ symbols.json เสมอ

export default async function handler(req, res) {
  try {
    const q = readQuery(req);
    const group = String(q.group || "").toLowerCase().trim();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual  = toBool(q.manual);
    const batchSize = clampInt(q.batchSize, 1, 200, 25);
    const cursor    = clampInt(q.cursor, 0, 1e9, 0);

    // 1) โหลดรายชื่อสด (ถ้าพลาด → fallback ไฟล์)
    const allSymbols = await getSymbolsForGroupLiveOrFallback(group);
    if (!Array.isArray(allSymbols) || allSymbols.length === 0) {
      return res.status(400).json({ error: `no symbols for group "${group}"` });
    }

    // 2) ตัด batch
    const start = isManual ? cursor : 0;
    const end   = isManual ? Math.min(start + batchSize, allSymbols.length)
                           : Math.min(batchSize, allSymbols.length);
    const batch = allSymbols.slice(start, end);

    // 3) สแกน (แทนที่ด้านในด้วย logic อินดิเคเตอร์จริงของคุณได้)
    const scanned = await scanSymbols(batch);

    // 4) รวมกับผลเก่าและเขียนกลับ
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
    return res.status(500).json({
      error: "scan failed",
      detail: (err && (err.stack || err.message)) || String(err)
    });
  }
}

/* ========================= Scanner (ใส่อินดิเคเตอร์จริง) ========================= */
// ตอนนี้ placeholder: 1D = "Sell", 1W = "-"
async function scanSymbols(symbols) {
  return symbols.map((ticker) => ({
    ticker,
    signalD: "Sell",   // TODO: ใส่ Buy/Sell/- จากอินดิเคเตอร์ 1D
    signalW: "-",      // TODO: ใส่ Buy/Sell/- จากอินดิเคเตอร์ 1W
    price: null,
    timeframe: "1D"
  }));
}

/* ============================ Live Symbols (หลัก/สำรอง) ============================ */

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
      // หลัก: slickcharts | สำรอง: datahub
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
      return defaultETFs50();
    case "gold":
      return ["GC=F", "XAUUSD=X"]; // Futures + Spot
    default:
      return [];
  }
}

// ---------- S&P500 ----------
async function fetchSP500Slickcharts() {
  const html = await getText("https://www.slickcharts.com/sp500");
  const re = /<td class="text-center">([A-Z.\-]{1,7})<\/td>/g;
  const out = new Set();
  let m;
  while ((m = re.exec(html))) out.add(m[1].toUpperCase().replace(/\./g, "-"));
  const arr = Array.from(out);
  if (arr.length < 400) throw new Error("slickcharts parse too small");
  return arr.slice(0, 500);
}
async function fetchSP500Datahub() {
  const js = await getJSON("https://datahub.io/core/s-and-p-500-companies/r/constituents.json");
  return js
    .map((x) => String(x.Symbol || "").toUpperCase().replace(/\./g, "-"))
    .filter(Boolean);
}

// ---------- Nasdaq100 ----------
async function fetchNasdaq100Wikipedia() {
  const html = await getText("https://en.wikipedia.org/wiki/Nasdaq-100");
  const set = new Set();
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g, "-"));
  const arr = Array.from(set).filter((x) => /^[A-Z\-]+$/.test(x));
  if (arr.length < 80) throw new Error("nas100 parse small");
  return arr.slice(0, 100);
}

// ---------- SET50/SET100 ----------
async function fetchSETWikipedia(which) {
  const page = which === "set50" ? "SET50_Index" : "SET100_Index";
  const html = await getText(`https://en.wikipedia.org/wiki/${page}`);
  const set = new Set();
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1].toUpperCase());
  let arr = Array.from(set).filter((x) => /^[A-Z]{2,6}$/.test(x));
  if (which === "set50" && arr.length < 40) throw new Error("set50 parse small");
  if (which === "set100" && arr.length < 80) throw new Error("set100 parse small");
  return arr.slice(0, which === "set50" ? 50 : 100);
}

// ---------- Bitkub ----------
async function fetchBitkubTHB() {
  const js = await getJSON("https://api.bitkub.com/api/market/symbols");
  const out = [];
  for (const it of js?.result || []) {
    const raw = String(it.symbol || ""); // "THB_BTC"
    const [fiat, coin] = raw.split("_");
    if (fiat === "THB" && coin) out.push(`${coin}_THB`);
  }
  return uniq(out).sort();
}

/* =========================== Defaults (crypto / ETFs) =========================== */

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
function defaultETFs50() {
  return ["SPY","QQQ","VTI","DIA","IWM","EEM","GLD","SLV","XLK","XLF",
          "XLE","XLI","XLY","XLP","XLV","XLC","XLU","VNQ","ARKK","TLT",
          "HYG","LQD","SHY","IEF","IBB","SMH","SOXX","XME","KRE","GDX",
          "XOP","XHB","XRT","XAR","XBI","XPH","XSW","XSD","KWEB","FXI",
          "EFA","EWT","EWY","EWW","EWZ","EWA","EWC","EWH","RSX","ASHR"];
}

/* ================================ GitHub I/O =============================== */

async function ghReadJSON(path, repo, branch) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op: "read", path, repo: repo || "", branch: branch || "" }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await safeFetch(url);
  return r.json();
}
async function ghWrite(path, repo, branch, content, message) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op: "write", path, repo: repo || "", branch: branch || "" }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await safeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, message })
  });
  return r.json();
}

async function mergeAndWriteSignals(payload) {
  const repo   = process.env.GH_REPO || process.env.GH_REPO_SYMBOLS;
  const branch = process.env.GH_BRANCH || "main";
  const path   = process.env.GH_PATH_SIGNALS || "data/signals.json";

  let prev = {};
  try { prev = await ghReadJSON(path, repo, branch); } catch { /* ignore */ }

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

  await ghWrite(path, repo, branch, JSON.stringify(merged, null, 2), `update signals ${payload.group}`);
  return merged;
}

/* ================================= Utils ================================== */

function readQuery(req) {
  if (req?.query && typeof req.query === "object") return req.query;
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const o = {};
    for (const [k, v] of u.searchParams.entries()) o[k] = v;
    return o;
  } catch { return {}; }
}
const UA_HDRS = { "User-Agent": "signal-dashboard/1.0" };

async function safeFetch(url, init = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  const r = await fetch(url, { ...init, headers: { ...(init.headers||{}), ...UA_HDRS }, signal: ctrl.signal });
  clearTimeout(id);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`${r.status} ${txt || r.statusText}`);
  }
  return r;
}
async function getText(url) { const r = await safeFetch(url); return r.text(); }
async function getJSON(url) { const r = await safeFetch(url); return r.json(); }

function toBool(v) {
  return ["1","true","yes","on"].includes(String(v||"").toLowerCase());
}
function clampInt(v, min, max, def) {
  const n = parseInt(v ?? "", 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}
const uniq = (arr) => Array.from(new Set((arr||[]).map(s => String(s||"").trim()).filter(Boolean)));
