// api/run-scan.js
// Self-contained batch scanner + live symbol sources (with safe fallbacks)
// No GH dependencies, no external state required.
// Runtime: Node.js (Vercel serverless default). 

export const config = {
  runtime: "nodejs",
};

let MEM_CACHE = {
  // symbols: { group -> [tickers] }
  symbols: {},
  // last scans: { group -> { updatedAt, results:[{ticker,signalD,signalW,price,timeframe}] } }
  scans: {},
};

// -------------- HTTP Handler -----------------
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return json(res, 400, { error: "missing ?group" });

    const isManual  = ["1","true","yes"].includes((url.searchParams.get("manual")||"").toLowerCase());
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, 500, 50);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);

    // 1) get symbols (live first, fallback if needed)
    const allSymbols = await getSymbols(group);
    if (!allSymbols.length) return json(res, 500, { error: `no symbols for ${group}` });

    // 2) batching
    const start = isManual ? cursor : 0;
    const end   = Math.min(start + batchSize, allSymbols.length);
    const batch = allSymbols.slice(start, end);

    // 3) scan batch (PUT YOUR REAL INDICATOR HERE)
    const scanned = await scanSymbols(batch);

    // 4) merge into memory (acts like signals.json)
    const merged = mergeToMemory(group, scanned);

    const nextCursor = end < allSymbols.length ? end : null;

    return json(res, 200, {
      ok: true,
      version: "r10",
      group,
      total: allSymbols.length,
      processed: scanned.length,
      start,
      end: end - 1,
      nextCursor,
      batchSize,
      savedCount: merged.results.length,
      savedPreview: merged,
    });
  } catch (e) {
    console.error("run-scan error:", e);
    return json(res, 500, { error: "scan failed", detail: String(e?.message || e) });
  }
}

// -------------- Scanner (ใส่ logic อินดิเคเตอร์จริงที่นี่) --------------
async function scanSymbols(symbols) {
  // TODO: แทนที่ด้วย logic จริงของคุณ
  // เดโม: ทำสัญญาณ 1D = "Sell" ทุกตัว, 1W = "Sell" ด้วย
  return symbols.map(ticker => ({
    ticker,
    signalD: "Sell",
    signalW: "Sell",
    price: null,
    timeframe: "1D",
  }));
}

// -------------- Symbol Sources --------------
async function getSymbols(group) {
  // cache
  if (Array.isArray(MEM_CACHE.symbols[group]) && MEM_CACHE.symbols[group].length) {
    return MEM_CACHE.symbols[group];
  }

  let out = [];
  try {
    switch (group) {
      case "sp500":
        out = await fetchSP500_Slickcharts();         // ~500
        if (out.length < 400) out = await fetchSP500_Datahub();
        break;
      case "nasdaq100":
        out = await fetchNasdaq100_Wikipedia();       // ~100
        break;
      case "altcoins":
        out = await topOKX_USDT(100);                 // top 100 USDT spot from OKX
        break;
      case "binance_top200":
        out = await topBinance_USDT(200);             // top 200 USDT spot from Binance
        break;
      case "okx_top200":
        out = await topOKX_USDT(200);                 // top 200 USDT spot from OKX
        break;
      case "bitkub":
        out = await bitkub_THB_All();                 // all THB pairs
        break;
      case "set50":
        out = await fetchSET_fromWikipedia(50);       // 50
        break;
      case "set100":
        out = await fetchSET_fromWikipedia(100);      // 100
        break;
      case "etfs":
        out = curatedETFs();                          // curated 50 (สั้นกว่า: 12 หลักๆ)
        break;
      case "gold":
        out = ["GC=F", "XAUUSD=X"];                   // Futures + Spot
        break;
      default:
        out = [];
    }
  } catch (e) {
    console.warn(`[symbols:${group}] live failed:`, e?.message || e);
    out = [];
  }

  // fallback เบื้องต้นถ้า live ว่าง
  if (!out.length) {
    out = fallback(group);
  }

  out = uniq(out);
  MEM_CACHE.symbols[group] = out;
  return out;
}

// ------- Live fetchers -------
async function fetchSP500_Slickcharts() {
  const html = await (await fetch("https://www.slickcharts.com/sp500", UA())).text();
  // parse column "Symbol" (works with slickcharts)
  const re = /<td class="text-center">([A-Z.\-]{1,7})<\/td>/g;
  const set = new Set();
  let m;
  while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g, "-"));
  const arr = Array.from(set);
  return arr.slice(0, 500);
}
async function fetchSP500_Datahub() {
  const r = await fetch("https://datahub.io/core/s-and-p-500-companies/r/constituents.json", UA());
  if (!r.ok) throw new Error(`datahub ${r.status}`);
  const js = await r.json();
  return js.map(x => String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean).slice(0, 500);
}
async function fetchNasdaq100_Wikipedia() {
  const html = await (await fetch("https://en.wikipedia.org/wiki/Nasdaq-100", UA())).text();
  const set = new Set();
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set).filter(x => /^[A-Z\-]+$/.test(x));
  return arr.slice(0, 100);
}

async function topBinance_USDT(limit) {
  // pull 24hr tickers and sort by quoteVolume desc
  const r = await fetch("https://api.binance.com/api/v3/ticker/24hr");
  if (!r.ok) throw new Error(`binance ${r.status}`);
  const js = await r.json();
  const list = js
    .filter(x => x.symbol.endsWith("USDT"))
    .filter(x => !/UPUSDT$|DOWNUSDT$|BULLUSDT$|BEARUSDT$/.test(x.symbol))
    .map(x => ({ s: x.symbol.toUpperCase() }))
    .sort((a, b) => (Number(b.q) || 0) - (Number(a.q) || 0)); // q not guaranteed, keep order stable
  const uniqList = uniq(list.map(o => o.s));
  return uniqList.slice(0, limit);
}

async function topOKX_USDT(limit) {
  // OKX instruments endpoint
  const r = await fetch("https://www.okx.com/api/v5/public/instruments?instType=SPOT");
  if (!r.ok) throw new Error(`okx ${r.status}`);
  const js = await r.json();
  const all = (js?.data || [])
    .map(x => String(x.instId || ""))      // e.g., "BTC-USDT"
    .filter(s => s.endsWith("-USDT"));
  // ไม่มี vol rank ตรง ๆ ใน endpoint นี้—ใช้การเรียงตามชื่อแล้วตัดจำนวน (ถ้าต้อง rank จริงค่อยเปลี่ยน endpoint 24h volume)
  const arr = uniq(all.map(s => s.replace("-", "")));
  return arr.slice(0, limit);
}

async function bitkub_THB_All() {
  const r = await fetch("https://api.bitkub.com/api/market/symbols", UA());
  if (!r.ok) throw new Error(`bitkub ${r.status}`);
  const js = await r.json();
  const out = [];
  for (const it of js?.result || []) {
    const raw = String(it.symbol || ""); // "THB_BTC"
    const [fiat, coin] = raw.split("_");
    if (fiat === "THB" && coin) out.push(`${coin}_THB`);
  }
  return uniq(out).sort();
}

async function fetchSET_fromWikipedia(n) {
  const page = n === 50 ? "SET50_Index" : "SET100_Index";
  const url = `https://en.wikipedia.org/wiki/${page}`;
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1].toUpperCase());
  const arr = Array.from(set).filter(x => /^[A-Z]{2,6}$/.test(x)).slice(0, n);
  return arr;
}

// curated ETFs (ย่อไว้ให้สำคัญก่อน; เพิ่มได้ตามต้องการ)
function curatedETFs() {
  return [
    "SPY","VOO","IVV","QQQ","DIA","IWM","EEM","ARKK",
    "XLK","XLF","XLE","XLY","XLP","XLV","XLI","XLU","VNQ",
    "VTI","SCHD","JEPQ","MSTY","O"
  ];
}

// fallback สำรองขั้นต่ำ (กันกรณีถูก CORS/บล็อก)
function fallback(group) {
  switch (group) {
    case "sp500":
      return ["AAPL","MSFT","NVDA","GOOGL","AMZN","META","AVGO","BRK-B","XOM","LLY"]; // short fallback
    case "nasdaq100":
      return ["AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","ADBE","NFLX","PEP"];
    case "altcoins":
      return ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT","AVAXUSDT","DOGEUSDT","MATICUSDT","DOTUSDT","LINKUSDT"];
    case "binance_top200":
    case "okx_top200":
      return ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT","AVAXUSDT","DOGEUSDT","MATICUSDT","DOTUSDT","LINKUSDT"];
    case "bitkub":
      return ["BTC_THB","ETH_THB","XRP_THB","ADA_THB","DOGE_THB","SOL_THB","BNB_THB","USDT_THB","SAND_THB","MANA_THB"];
    case "set50":
      return ["ADVANC","AOT","BDMS","BBL","PTT","PTTEP","CPALL","KBANK","KTB","SCB"];
    case "set100":
      return ["ADVANC","AOT","BDMS","BBL","PTT","PTTEP","CPALL","KBANK","KTB","SCB","AAV","BCH","BEM","BH","BJC","BTS","CRC","DTAC","EGCO","GLOBAL"];
    case "etfs":
      return curatedETFs();
    case "gold":
      return ["GC=F","XAUUSD=X"];
    default:
      return [];
  }
}

// -------------- Merge memory ----------------
function mergeToMemory(group, batchResults) {
  const prev = MEM_CACHE.scans[group]?.results || [];
  const map = new Map(prev.map(r => [r.ticker, r]));
  for (const r of batchResults) map.set(r.ticker, r);
  const merged = {
    group,
    updatedAt: new Date().toISOString(),
    results: Array.from(map.values())
  };
  MEM_CACHE.scans[group] = merged;
  return merged;
}

// -------------- Utils ----------------
const UA = () => ({ headers: { "User-Agent": "signal-dashboard/1.0" } });
const json = (res, code, obj) => { res.statusCode = code; res.setHeader("Content-Type","application/json"); res.end(JSON.stringify(obj)); };
const clampInt = (v, min, max, def) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};
const uniq = arr => Array.from(new Set((arr||[]).map(s => String(s||"").trim()).filter(Boolean)));
