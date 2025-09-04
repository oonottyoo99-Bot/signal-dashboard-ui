// api/run-scan.js — r11
// Batch scan + live symbol sources (multi-source) + in-memory merge
// ไม่มีการพึ่งพา GH_* อีกต่อไป

export const config = { runtime: "nodejs" };

let MEM = {
  symbols: {},   // { group -> [tickers] }
  scans:   {},   // { group -> {updatedAt, results:[...] } }
};

// -------------------- HTTP --------------------
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return j(res, 400, { error: "missing ?group" });

    const isManual  = ["1","true","yes"].includes((url.searchParams.get("manual")||"").toLowerCase());
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, 1000, 100);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);

    const all = await getSymbols(group);
    if (!all.length) return j(res, 500, { error: `no symbols for ${group}` });

    const start = isManual ? cursor : 0;
    const end   = Math.min(start + batchSize, all.length);
    const batch = all.slice(start, end);

    const scanned = await scanSymbols(batch); // TODO: ใส่อินดิเคเตอร์จริงของคุณ
    const merged  = mergeToMem(group, scanned);

    return j(res, 200, {
      ok: true,
      version: "r11",
      group,
      total: all.length,
      processed: scanned.length,
      start,
      end: end - 1,
      nextCursor: end < all.length ? end : null,
      batchSize,
      savedCount: merged.results.length,
      savedPreview: merged,
    });
  } catch (e) {
    console.error("run-scan error:", e);
    return j(res, 500, { error: "scan failed", detail: String(e?.message || e) });
  }
}

// -------------------- Scanner (ใส่จริงตรงนี้) --------------------
async function scanSymbols(symbols) {
  // !! สำคัญ: ตอนนี้เป็น placeholder
  // - 1D: "Sell"
  // - 1W: "Sell"
  // หากคุณส่ง endpoint/กติกาอินดิเคเตอร์มา (เช่น GET /signal?ticker=...&tf=1W)
  // ผมจะเปลี่ยนให้ดึงค่าจริงทันที
  return symbols.map(t => ({
    ticker: t,
    signalD: "Sell",
    signalW: "Sell",
    price: null,
    timeframe: "1D",
  }));
}

// -------------------- Live symbol sources --------------------
async function getSymbols(group) {
  if (Array.isArray(MEM.symbols[group]) && MEM.symbols[group].length) return MEM.symbols[group];

  let list = [];
  try {
    switch (group) {
      case "sp500": {
        // 1) Wikipedia official list (500)
        list = await sp500_wikipediaList();
        // 2) Slickcharts backup
        if (list.length < 400) list = await sp500_slickcharts();
        // 3) Datahub last-resort
        if (list.length < 400) list = await sp500_datahub();
        break;
      }
      case "nasdaq100": {
        list = await nasdaq100_wikipedia();
        break;
      }
      case "altcoins": {
        list = await okx_topUSDT(100); // top 100
        break;
      }
      case "binance_top200": {
        // try 24h → fallback exchangeInfo
        list = await binance_topUSDT_by24hr(200);
        if (list.length < 180) list = await binance_usdtFromExchangeInfo(200);
        break;
      }
      case "okx_top200": {
        list = await okx_topUSDT(200);
        break;
      }
      case "bitkub": {
        list = await bitkub_allTHB();
        break;
      }
      case "set50": {
        list = await set_fromWikipedia(50);
        break;
      }
      case "set100": {
        list = await set_fromWikipedia(100);
        break;
      }
      case "etfs": {
        list = curatedETFs();
        break;
      }
      case "gold": {
        list = ["GC=F","XAUUSD=X"];
        break;
      }
      default:
        list = [];
    }
  } catch (e) {
    console.warn(`[${group}] live failed:`, e?.message || e);
    list = [];
  }

  if (!list.length) list = bigFallback(group); // fallback ชุดใหญ่ ไม่ใช่ 10 ตัวแล้ว
  list = uniq(list);
  MEM.symbols[group] = list;
  return list;
}

// ------ S&P 500 ------
async function sp500_wikipediaList() {
  const url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
  const html = await (await fetch(url, UA())).text();
  // ดึงคอลัมน์แรก (Symbol) ของตาราง constituents
  // มีตารางอื่นบนหน้าเดียวกัน ใช้ regex กว้าง ๆ แล้วกรองด้วยรูปแบบ ticker
  const re = /<td><a[^>]*>([A-Z.\-]{1,7})<\/a><\/td>/g;
  const set = new Set(); let m;
  while ((m = re.exec(html))) {
    const sym = m[1].toUpperCase().replace(/\./g,"-");
    if (/^[A-Z\-]{1,7}$/.test(sym)) set.add(sym);
  }
  return Array.from(set).slice(0, 500);
}
async function sp500_slickcharts() {
  const html = await (await fetch("https://www.slickcharts.com/sp500", UA())).text();
  const re = /<td class="text-center">([A-Z.\-]{1,7})<\/td>/g;
  const set = new Set(); let m;
  while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  return Array.from(set).slice(0, 500);
}
async function sp500_datahub() {
  const r = await fetch("https://datahub.io/core/s-and-p-500-companies/r/constituents.json", UA());
  if (!r.ok) throw new Error(`datahub ${r.status}`);
  const js = await r.json();
  return js.map(x => String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean).slice(0, 500);
}

// ------ Nasdaq 100 ------
async function nasdaq100_wikipedia() {
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  // โครงสร้างตารางเปลี่ยนบ่อย ใช้ regex หลวมแล้วกรอง
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const sym = m[1].toUpperCase().replace(/\./g,"-");
    if (/^[A-Z\-]{1,7}$/.test(sym)) set.add(sym);
  }
  const arr = Array.from(set).filter(x => /^[A-Z\-]+$/.test(x));
  return arr.slice(0, 100);
}

// ------ Binance ------
async function binance_topUSDT_by24hr(limit) {
  const r = await fetch("https://api.binance.com/api/v3/ticker/24hr", UA());
  if (!r.ok) throw new Error(`binance 24hr ${r.status}`);
  const js = await r.json();
  // ไม่มีการันตี field ปริมาณเท่ากันทุกตัว ใช้ quoteVolume ถ้ามี ไม่งั้น 0
  const list = js
    .filter(x => String(x.symbol||"").toUpperCase().endsWith("USDT"))
    .filter(x => !/UPUSDT$|DOWNUSDT$|BULLUSDT$|BEARUSDT$/.test(x.symbol))
    .map(x => ({ s: String(x.symbol).toUpperCase(), v: Number(x.quoteVolume||x.volume||0) }))
    .sort((a,b)=> b.v - a.v)
    .map(o => o.s);
  return uniq(list).slice(0, limit);
}
async function binance_usdtFromExchangeInfo(limit) {
  const r = await fetch("https://api.binance.com/api/v3/exchangeInfo", UA());
  if (!r.ok) throw new Error(`binance exchangeInfo ${r.status}`);
  const js = await r.json();
  const list = (js?.symbols || [])
    .filter(s => s?.status === "TRADING")
    .filter(s => String(s?.quoteAsset).toUpperCase() === "USDT")
    .map(s => String(s.symbol).toUpperCase())
    .filter(s => !/UPUSDT$|DOWNUSDT$|BULLUSDT$|BEARUSDT$/.test(s))
    .sort();
  return list.slice(0, limit);
}

// ------ OKX ------
async function okx_topUSDT(limit) {
  const r = await fetch("https://www.okx.com/api/v5/public/instruments?instType=SPOT", UA());
  if (!r.ok) throw new Error(`okx ${r.status}`);
  const js = await r.json();
  const all = (js?.data || [])
    .map(x => String(x.instId||""))
    .filter(s => s.endsWith("-USDT"))
    .map(s => s.replace("-", "")) // BTCUSDT
    .sort();
  return uniq(all).slice(0, limit);
}

// ------ Bitkub ------
async function bitkub_allTHB() {
  const r = await fetch("https://api.bitkub.com/api/market/symbols", UA());
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

// ------ SET50 / SET100 ------
async function set_fromWikipedia(n) {
  const page = n === 50 ? "SET50_Index" : "SET100_Index";
  const url = `https://en.wikipedia.org/wiki/${page}`;
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase());
  return Array.from(set).filter(x => /^[A-Z]{2,6}$/.test(x)).slice(0, n);
}

// ------ ETFs curated ------
function curatedETFs() {
  return ["SPY","VOO","IVV","QQQ","DIA","IWM","EEM","ARKK","XLK","XLF","XLE","XLY","XLP","XLV","XLI","XLU","VNQ","VTI","SCHD","JEPQ","MSTY","O"];
}

// ------ Big fallback (กันเว็บปลายทางล่ม) ------
function bigFallback(group) {
  switch(group) {
    case "sp500":   // รายการย่อ (มากกว่าเดิม), แต่แนะนำให้ใช้ live เป็นหลัก
      return ["AAPL","MSFT","NVDA","AMZN","META","GOOGL","AVGO","BRK-B","LLY","XOM","UNH","JPM","JNJ","V","PG","MA","COST","HD","TSLA","ABBV",
              "PEP","MRK","KO","BAC","WMT","NFLX","LIN","ORCL","ACN","CRM","CSCO","MCD","WFC","DHR","ABT","TMO","TXN","AMD","IBM","NEE",
              "PM","ISRG","UNP","RTX","LOW","INTU","CVX","QCOM","AMAT"]; // ~50
    case "nasdaq100":
      return ["AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","ADBE","PEP","AVGO","CSCO","COST","AMD","NFLX","CMCSA","TXN","INTC","LIN","AMGN","INTU",
              "SBUX","QCOM","GILD","BKNG","ADP","MRVL","MDLZ","ISRG","PYPL","PDD","VRTX","REGN","LRCX","CSX","MU","PANW","MAR","KLAC","KDP","ADI",
              "SNPS","CDNS","CRWD","FTNT","NXPI","AEP","EXC","KHC","MNST","CTAS"]; // ~50
    case "binance_top200":
      return ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT","AVAXUSDT","DOGEUSDT","MATICUSDT","DOTUSDT","LINKUSDT",
              "BNBUSDT","TONUSDT","BCHUSDT","LTCUSDT","NEARUSDT","APTUSDT","OPUSDT","SUIUSDT","ARBUSDT","FILUSDT"]; // 20
    case "okx_top200":
      return ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT","AVAXUSDT","DOGEUSDT","MATICUSDT","DOTUSDT","LINKUSDT"]; // 10+
    case "set50":
      return ["ADVANC","AOT","BDMS","BBL","PTT","PTTEP","CPALL","KBANK","KTB","SCB","EGCO","EA","GPSC","GULF","BH","BEM","BJC","BTS","CRC","CK",
              "DELTA","CPN","LH","MINT","MAKRO","OSP","OR","PTTEP","RATCH","TISCO","TNNGF","TOP","TIDLOR","TU","TASCO","INTUCH","KCE","HANA","KEX","IVL",
              "BGRIM","IRPC","TRUE","CENTEL","AMATA","CKP","TMB","SCGP","SCC"]; // ~50
    case "set100":
      return ["ADVANC","AOT","BDMS","BBL","PTT","PTTEP","CPALL","KBANK","KTB","SCB","AAV","BCH","BEM","BH","BJC","BTS","CRC","DTAC","EGCO","GLOBAL",
              "GULF","IVL","KCE","LH","MAKRO","MINT","OR","OSP","RATCH","SAWAD","SCGP","SCC","SPRC","STA","TISCO","TOP","TASCO","TIDLOR","TPIPP","TTB",
              "TU","WHA","INTUCH","CK","CKP","EA","DELTA","GPSC","TRUE","BCP","BANPU","CPN","DOHOME","EA-R","EASTW","HMPRO","KEX","MEGA","OSP-R","PLANB",
              "PTG","ROBINS","RCL","SAWAD-R","SINGER","SPALI","STARK","TFFIF","TNNGF","TTCL","TTW","VGI","TOA","BLA","BPP","BAM","BJC-R","CPALL-R","CRC-R","GPSC-R","IVL-R","KTB-R","LH-R"]; // ~100 (ประมาณการ)
    default:
      return [];
  }
}

// -------------------- Merge & Utils --------------------
function mergeToMem(group, batch) {
  const prev = MEM.scans[group]?.results || [];
  const map = new Map(prev.map(r => [r.ticker, r]));
  for (const r of batch) map.set(r.ticker, r);
  const merged = { group, updatedAt: new Date().toISOString(), results: Array.from(map.values()) };
  MEM.scans[group] = merged;
  return merged;
}

const UA = () => ({
  headers: {
    "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "Accept-Language":"en-US,en;q=0.8",
    "Cache-Control":"no-cache",
  }
});
const j = (res, code, obj) => { res.statusCode = code; res.setHeader("Content-Type","application/json"); res.end(JSON.stringify(obj)); };
const clampInt = (v,min,max,def)=>{ const n=parseInt(v??"",10); return Number.isFinite(n)? Math.max(min,Math.min(max,n)) : def; };
const uniq = arr => Array.from(new Set((arr||[]).map(x => String(x||"").trim()).filter(Boolean)));
