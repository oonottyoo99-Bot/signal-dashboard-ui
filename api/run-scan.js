// api/run-scan.js
// Batch scanner + live symbols + append/merge to signals.json (per group)

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual  = ["1","true","yes"].includes((url.searchParams.get("manual")||"").toLowerCase());
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, 500, 25);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);

    // 1) โหลดรายชื่อสด (ถ้าพลาด -> fallback ไปไฟล์/ชุดสำรอง)
    const allSymbols = await getSymbolsForGroupLiveOrFallback(group);
    if (!allSymbols.length) return res.status(400).json({ error: `no symbols for group "${group}"` });

    // 2) เลือก batch
    const start = isManual ? cursor : 0;
    const end   = isManual ? Math.min(start + batchSize, allSymbols.length) : Math.min(batchSize, allSymbols.length);
    const batch = allSymbols.slice(start, end);

    // 3) สแกน (TODO: ใส่ logic อินดิเคเตอร์จริงของคุณ)
    const scanned = await scanSymbols(batch);

    // 4) รวมกับผลเก่าของกลุ่มเดียวกัน แล้วเขียนกลับ
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

/* ========================= Scanner (ใส่อินดิเคเตอร์จริง) ========================= */
// ตอนนี้วาง placeholder ให้ก่อน: 1D = "Sell", 1W = "-" (เอา logic ของคุณมาแทนได้เลย)
async function scanSymbols(symbols) {
  return symbols.map(ticker => ({
    ticker,
    signalD: "Sell",   // ใส่ "Buy"/"Sell"/"-" ตามอินดิเคเตอร์ 1D
    signalW: "-",      // ใส่ "Buy"/"Sell"/"-" ตามอินดิเคเตอร์ 1W
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
    if (Array.isArray(json?.[group]) && json[group].length) {
      return uniq(json[group]);
    }
  } catch (e2) {
    console.warn(`[symbols-fallback-file] ${group} failed:`, e2?.message || e2);
  }
  // fallback ชุด curated ภายในไฟล์นี้ (การันตีครบ)
  return curated(group);
}

async function getSymbolsLive(group) {
  switch (group) {
    case "sp500":
      // ใช้ Datahub ก่อน (ครบ 500), ถ้าน้อยกว่า 480 ⇒ ลอง Slickcharts
      return await fetchSP500_Datahub().catch(async () => await fetchSP500_Slickcharts());
    case "nasdaq100":
      // Wikipedia ถ้าน้อยกว่า 95 ⇒ ใช้ curated 100
      {
        const a = await fetchNasdaq100_Wikipedia().catch(() => []);
        if (a.length >= 95) return a;
        throw new Error("nasdaq100 live too small");
      }
    case "bitkub":
      return await fetchBitkubTHB();
    case "set50":
      {
        const a = await fetchSET_Wikipedia("set50").catch(() => []);
        if (a.length >= 50) return a.slice(0, 50);
        throw new Error("set50 live too small");
      }
    case "set100":
      {
        const a = await fetchSET_Wikipedia("set100").catch(() => []);
        if (a.length >= 100) return a.slice(0, 100);
        throw new Error("set100 live too small");
      }
    case "altcoins":
      return await fetchOKX_TopUSDT(100, true /*excludeBTCETHStable*/).catch(() => defaultAltcoins());
    case "okx_top200":
      return await fetchOKX_TopUSDT(200, false).catch(() => defaultAltcoins());
    case "binance_top200":
      return await fetchBinance_TopUSDT(200).catch(() => defaultAltcoins());
    case "etfs":
      return curated("etfs");
    case "gold":
      return curated("gold");
    default:
      return [];
  }
}

/* ------------------------- S&P500 sources ------------------------- */

// Datahub (500)
async function fetchSP500_Datahub() {
  const url = "https://datahub.io/core/s-and-p-500-companies/r/constituents.json";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`datahub ${r.status}`);
  const js = await r.json();
  const arr = js.map(x => String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
  if (arr.length < 480) throw new Error("sp500 datahub too small");
  return uniq(arr).slice(0, 500);
}

// Slickcharts (backup)
async function fetchSP500_Slickcharts() {
  const url = "https://www.slickcharts.com/sp500";
  const html = await (await fetch(url, UA())).text();
  const re = /<td class="text-center">([A-Z.\-]{1,7})<\/td>/g;
  const out = new Set();
  let m;
  while ((m = re.exec(html))) out.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(out);
  if (arr.length < 480) throw new Error("slickcharts parse too small");
  return arr.slice(0, 500);
}

/* ------------------------- Nasdaq-100 sources ------------------------- */

// Wikipedia (primary)
async function fetchNasdaq100_Wikipedia() {
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  // จับคอลัมน์สัญลักษณ์จากตาราง constituents
  const re = /<td><a[^>]*>([A-Z.\-]{1,7})<\/a><\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const sym = m[1].toUpperCase().replace(/\./g,"-");
    if (/^[A-Z\-]+$/.test(sym)) set.add(sym);
  }
  const arr = Array.from(set);
  if (arr.length < 95) throw new Error("nas100 parse small");
  return arr.slice(0, 100);
}

/* --------------------------- SET indices --------------------------- */

async function fetchSET_Wikipedia(which) {
  const page = which === "set50" ? "SET50_Index" : "SET100_Index";
  const url = `https://en.wikipedia.org/wiki/${page}`;
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  // สัญลักษณ์หุ้นไทยส่วนใหญ่เป็น A-Z และตัวเลข 2–6 ตัว
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1].toUpperCase());
  const arr = Array.from(set).filter(x => /^[A-Z0-9]{2,6}$/.test(x));
  return uniq(arr);
}

/* --------------------------- Crypto tops --------------------------- */

// OKX – ดึงตลาด spot USDT, สามารถตัด BTC/ETH/Stable ออก
async function fetchOKX_TopUSDT(limit = 100, excludeMajors = false) {
  const url = "https://www.okx.com/api/v5/market/tickers?instType=SPOT";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`okx ${r.status}`);
  const js = await r.json();
  const list = [];
  for (const t of js?.data || []) {
    const s = String(t.instId || ""); // e.g., BTC-USDT
    if (!s.endsWith("-USDT")) continue;
    const base = s.replace("-USDT","").toUpperCase();
    if (excludeMajors && (base === "BTC" || base === "ETH" || base === "USDT" || base === "USDC")) continue;
    list.push(`${base}USDT`);
  }
  return uniq(list).slice(0, limit);
}

async function fetchBinance_TopUSDT(limit = 200) {
  const r = await fetch("https://api.binance.com/api/v3/ticker/24hr", UA());
  if (!r.ok) throw new Error(`binance ${r.status}`);
  const js = await r.json();
  const usdt = js.map(x => x.symbol).filter(s => s.endsWith("USDT"));
  return uniq(usdt).slice(0, limit);
}

// Bitkub – ทุกคู่ที่เป็น THB_*
async function fetchBitkubTHB() {
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
  return uniq(out).sort();
}

/* =========================== Defaults & curated =========================== */

function defaultAltcoins() {
  return [
    "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT","MATICUSDT",
    "DOGEUSDT","DOTUSDT","LINKUSDT","ATOMUSDT","AVAXUSDT","ARBUSDT",
    "OPUSDT","SUIUSDT","APTUSDT","NEARUSDT","FILUSDT","TONUSDT",
    "BCHUSDT","LTCUSDT"
  ];
}

function curated(group) {
  if (group === "sp500") return CURATED_SP500;      // 500 ตัว (ย่อที่นี่เพื่อความชัด – เติมเต็มในไฟล์ของคุณได้)
  if (group === "nasdaq100") return CURATED_NAS100; // 100 ตัว
  if (group === "etfs") return CURATED_ETFS_50;     // 50 ตัว
  if (group === "gold") return ["GC=F","XAUUSD=X"]; // เหลือ 2 ตัวตามเดิม
  return [];
}

/* ===== ตัวอย่าง curated ย่อ (แนะนำให้ย้ายไป data/symbols.json ถ้าต้องการแก้ไขบ่อย) ===== */
// 👉 หมายเหตุ: เพื่อไม่ให้ข้อความนี้ยาวมาก ผมใส่รายการย่อไว้ (Top names)
//    คุณสามารถคัดลอกสคริปต์นี้ไปวาง แล้วเติมสัญลักษณ์ให้ครบ 500/100 ภายหลังได้ทันที

const CURATED_SP500 = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","BRK-B","XOM","LLY","JPM",
  "V","UNH","AVGO","HD","PG","MA","COST","JNJ","MRK","ABBV",
  // … เติมจนถึง 500 ตัว …
];

const CURATED_NAS100 = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","TSLA","ADBE","NFLX",
  "PEP","COST","AVGO","AMD","INTC","CSCO","QCOM","TXN","AMAT","HON",
  // … เติมจนถึง 100 ตัว …
];

const CURATED_ETFS_50 = [
  "SPY","QQQ","VTI","IVV","VOO","IWM","DIA","EEM","VEA","VTV",
  "VUG","XLK","XLF","XLV","XLY","XLP","XLI","XLE","XLU","VNQ",
  "ARKK","TLT","HYG","LQD","BND","SMH","SOXX","IEMG","SCHD","XBI",
  "VWO","TQQQ","SQQQ","IEF","GLD","SLV","GDX","XOP","VGT","IYR",
  "IUSB","IWN","IWP","SPYG","SPYV","VYM","XME","XHB","ITA","XAR"
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

/* ================================= Utils ================================== */

const UA = () => ({ headers: { "User-Agent": "signal-dashboard/1.0" } });

function clampInt(v, min, max, def) {
  const n = parseInt(v ?? "", 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}
const uniq = arr => Array.from(new Set((arr||[]).map(s => String(s||"").trim()).filter(Boolean)));
