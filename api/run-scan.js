// api/run-scan.js
// r10 – Batch scan + live symbol lists (robust) + indicator(1D/1W) + merge to data/signals.json

export const config = { runtime: "edge" };

/**
 * ตั้งค่าอินดิเคเตอร์ของคุณ (ถ้ามี)
 * ตัวอย่าง:
 *   IND_API=https://your-ta.example.com/signal?symbol={SYMBOL}&tf={TF}
 *    - {SYMBOL} จะถูกแทนเช่น "AAPL" หรือ "BTCUSDT" หรือ "ETH_THB"
 *    - {TF} จะเป็น "1D" หรือ "1W"
 * API ควรตอบ {"signal":"Buy"} หรือ {"signal":"Sell"} หรือ {"signal":"-"}
 */
const IND_API = process.env.IND_API || ""; // เว้นว่างได้ (จะคืน "-")

// GitHub I/O targets
const GH_REPO = process.env.GH_REPO || process.env.GH_REPO_SYMBOLS || "";
const GH_BRANCH = process.env.GH_BRANCH || "main";
const PATH_SYMBOLS = process.env.GH_PATH_SYMBOLS || "data/symbols.json";
const PATH_SIGNALS = process.env.GH_PATH_SIGNALS || "data/signals.json";

// ขีดจำกัดจำนวนสูงสุดต่อกลุ่ม (กันหน้าเว็บชี้เป้าได้ครบ)
const GROUP_LIMITS = {
  sp500: 500,
  nasdaq100: 100,
  okx_top200: 200,
  binance_top200: 200,
  bitkub: 10_000,     // เอาทุกคู่ THB ทั้งเว็บ
  set50: 50,
  set100: 100,
  altcoins: 100,      // OKX altcoins top 100 (USDT)
  etfs: 22,
  gold: 2,
};

const UA = () => ({ headers: { "User-Agent": "signal-dashboard/1.0" } });

/* ====================== HTTP helpers ====================== */

async function httpJSON(url, opt = {}) {
  const r = await fetch(url, { ...UA(), ...opt });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
async function httpText(url) {
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

/* ====================== GitHub proxy (ที่คุณมีอยู่แล้ว) ====================== */

async function ghReadJSON(path) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op: "read", path, repo: GH_REPO, branch: GH_BRANCH }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`ghRead ${r.status} ${await r.text()}`);
  return r.json();
}

async function ghWrite(path, content, message) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op: "write", path, repo: GH_REPO, branch: GH_BRANCH }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, message }),
  });
  if (!r.ok) throw new Error(`ghWrite ${r.status} ${await r.text()}`);
  return r.json();
}

/* ====================== Symbols (live + fallback) ====================== */

async function getSymbols(group) {
  // พยายาม live ก่อน → ถ้าล้มเหลว fallback ไปไฟล์
  const live = await getSymbolsLive(group).catch(() => null);
  if (Array.isArray(live) && live.length) return uniq(live).slice(0, GROUP_LIMITS[group] || live.length);

  // fallback
  const json = await ghReadJSON(PATH_SYMBOLS).catch(() => ({}));
  const arr = Array.isArray(json?.[group]) ? json[group] : [];
  return uniq(arr).slice(0, GROUP_LIMITS[group] || arr.length);
}

async function getSymbolsLive(group) {
  switch (group) {
    case "sp500":       return fetchSP500_Slickcharts();
    case "nasdaq100":   return fetchNasdaq100_Wiki();
    case "okx_top200":  return fetchOKX_TopN_USDT(200);
    case "binance_top200": return fetchBinance_TopN_USDT(200);
    case "altcoins":    return fetchOKX_TopN_USDT(100, true); // กรอง BTC/ETH/stable ออก
    case "bitkub":      return fetchBitkub_THB();
    case "set50":       return fetchSET_Wiki(50);
    case "set100":      return fetchSET_Wiki(100);
    case "etfs":        return [
      "SPY","QQQ","VOO","IVV","IWM","EEM","ARKK","DIA","VNQ","MSTY","JEPQ","SCHD","VTI","XLK","XLF","XLE","XLY","XLI","XLV","XLU","XLRE","O"
    ];
    case "gold":        return ["GC=F","XAUUSD=X"];
    default:            return [];
  }
}

// --- S&P500 (Slickcharts) ---
async function fetchSP500_Slickcharts() {
  const html = await httpText("https://www.slickcharts.com/sp500");
  const re = /<td class="text-center">([A-Z.\-]{1,7})<\/td>/g;
  const out = new Set(); let m;
  while ((m = re.exec(html))) out.add(m[1].toUpperCase().replace(/\./g, "-"));
  const arr = Array.from(out);
  if (arr.length < 400) throw new Error("slickcharts too few");
  return arr.slice(0, 500);
}

// --- Nasdaq100 (Wikipedia) ---
async function fetchNasdaq100_Wiki() {
  const html = await httpText("https://en.wikipedia.org/wiki/Nasdaq-100");
  const set = new Set();
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g, "-"));
  const arr = Array.from(set).filter(x => /^[A-Z\-]+$/.test(x));
  if (arr.length < 80) throw new Error("nas100 few");
  return arr.slice(0, 100);
}

// --- SET50/SET100 (Wikipedia) ---
async function fetchSET_Wiki(n) {
  const page = n === 50 ? "SET50_Index" : "SET100_Index";
  const html = await httpText(`https://en.wikipedia.org/wiki/${page}`);
  const set = new Set(); const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase());
  const arr = Array.from(set).filter(x => /^[A-Z]{2,6}$/.test(x));
  if ((n === 50 && arr.length < 40) || (n === 100 && arr.length < 80)) throw new Error("set few");
  return arr.slice(0, n);
}

// --- Bitkub (official) — THB pairs ---
async function fetchBitkub_THB() {
  const js = await httpJSON("https://api.bitkub.com/api/market/symbols");
  const out = [];
  for (const it of js?.result || []) {
    const raw = String(it.symbol || ""); // "THB_BTC"
    const [fiat, coin] = raw.split("_");
    if (fiat === "THB" && coin) out.push(`${coin}_THB`);
  }
  return uniq(out).sort();
}

// --- OKX top USDT by vol (public) ---
async function fetchOKX_TopN_USDT(N, altOnly = false) {
  // https://www.okx.com/api/v5/market/tickers?instType=SPOT
  // เลือกเฉพาะ *USDT*
  const js = await httpJSON("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
  const items = (js?.data || [])
    .filter(x => x.instId && x.instId.endsWith("-USDT"))
    .map(x => ({ sym: x.instId.replace("-", ""), vol: Number(x.volCcy24h || x.vol24h || 0) }));

  let list = items;
  if (altOnly) {
    list = list.filter(x => !/^BTCUSDT|ETHUSDT|USDTUSDT$/i.test(x.sym));
  }
  list.sort((a,b) => b.vol - a.vol);
  return list.slice(0, N).map(x => x.sym);
}

// --- Binance top USDT by vol (public) ---
async function fetchBinance_TopN_USDT(N) {
  // https://api.binance.com/api/v3/ticker/24hr
  const arr = await httpJSON("https://api.binance.com/api/v3/ticker/24hr");
  const items = (arr || [])
    .filter(x => x.symbol && x.symbol.endsWith("USDT"))
    .map(x => ({ sym: x.symbol, vol: Number(x.quoteVolume || x.volume || 0) }))
    .sort((a,b) => b.vol - a.vol)
    .slice(0, N)
    .map(x => x.sym);
  return items;
}

/* ====================== Indicator fetch ====================== */

async function getSignalFromIndicator(ticker, tf) {
  if (!IND_API) return "-";
  const url = IND_API
    .replace("{SYMBOL}", encodeURIComponent(ticker))
    .replace("{TF}", tf);
  try {
    const js = await httpJSON(url);
    const s = (js?.signal || "-").toString();
    if (/^buy$/i.test(s)) return "Buy";
    if (/^sell$/i.test(s)) return "Sell";
    return "-";
  } catch {
    return "-"; // ไม่เด้งเป็น Sell โดยไม่มีข้อมูล เพื่อไม่ให้ขัดกับชาร์ตจริง
  }
}

/* ====================== Scanner ====================== */

async function scanSymbols(batch) {
  // จำกัด concurrency = 6 เพื่อไม่โดน rate limit
  const CONC = 6;
  const out = [];
  let i = 0;

  async function worker() {
    while (i < batch.length) {
      const idx = i++;
      const ticker = batch[idx];
      const [d, w] = await Promise.all([
        getSignalFromIndicator(ticker, "1D"),
        getSignalFromIndicator(ticker, "1W"),
      ]);
      out.push({
        ticker,
        signalD: d,
        signalW: w,
        price: null,
        timeframe: "1D",
      });
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  return out;
}

/* ====================== Merge & Save ====================== */

async function mergeAndWriteSignals(payload) {
  let prev = {};
  try { prev = await ghReadJSON(PATH_SIGNALS); } catch {}
  const map = new Map();

  if (prev?.group === payload.group && Array.isArray(prev?.results)) {
    for (const r of prev.results) map.set(r.ticker, r);
  }
  for (const r of payload.results) map.set(r.ticker, r);

  const merged = {
    group: payload.group,
    updatedAt: payload.updatedAt,
    results: Array.from(map.values()),
  };
  await ghWrite(PATH_SIGNALS, JSON.stringify(merged, null, 2), `update data/signals.json (${payload.group})`);
  return merged;
}

/* ====================== Handler ====================== */

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return json(400, { error: "missing ?group" });

    const isManual  = ["1","true","yes"].includes((url.searchParams.get("manual")||"").toLowerCase());
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, 500, 50);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);

    const all = await getSymbols(group);
    if (!all.length) return json(400, { error: `no symbols for ${group}` });

    const start = isManual ? cursor : 0;
    const end   = Math.min(start + batchSize, all.length);
    const slice = all.slice(start, end);

    const scanned = await scanSymbols(slice);
    const merged  = await mergeAndWriteSignals({
      group, updatedAt: new Date().toISOString(), results: scanned
    });

    const nextCursor = end < all.length ? end : null;

    return json(200, {
      ok: true,
      version: "r10",
      group,
      total: all.length,
      processed: scanned.length,
      start,
      end: end - 1,
      nextCursor,
      batchSize,
      savedCount: merged.results?.length || 0,
      savedPreview: merged
    });
  } catch (e) {
    return json(500, { error: "scan failed", detail: String(e?.message || e) });
  }
}

/* ====================== utils ====================== */
function uniq(arr){ return Array.from(new Set((arr||[]).map(s=>String(s||"").trim()).filter(Boolean))); }
function clampInt(v,min,max,def){ const n=parseInt(v??"",10); return Number.isFinite(n)?Math.max(min,Math.min(max,n)):def; }
function json(code,obj){ return new Response(JSON.stringify(obj),{status:code,headers:{ "content-type":"application/json"}}); }
