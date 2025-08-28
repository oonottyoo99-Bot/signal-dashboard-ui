// api/run-scan.js
// Batch scanner + live symbol sources + merge append into signals.json (per group)

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual  = toBool(url.searchParams.get("manual"));
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, 500, 50);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);

    // 1) โหลดรายชื่อสด (มี fallback)
    const allSymbols = await getSymbolsForGroupLiveOrFallback(group);
    if (!allSymbols.length) {
      return res.status(400).json({ error: `no symbols for group "${group}"` });
    }

    // 2) ตัด batch
    const start = isManual ? cursor : 0;
    const end   = isManual ? Math.min(start + batchSize, allSymbols.length)
                           : Math.min(batchSize, allSymbols.length);
    const batch = allSymbols.slice(start, end);

    // 3) สแกน (แทนที่ด้วยอินดิเคเตอร์จริงของคุณ)
    const scanned = await scanSymbols(batch);

    // 4) รวม/เขียนกลับ (merge ตาม ticker)
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
async function scanSymbols(symbols) {
  // TODO: ใส่ logic อินดิเคเตอร์ 1D/1W จริงของคุณที่นี่
  return symbols.map(ticker => ({
    ticker,
    signalD: "Sell",
    signalW: "-",
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
      return await fetchSP500_Slickcharts_500()
              .catch(async () => await fetchSP500_Datahub());
    case "nasdaq100":
      // ใช้ slickcharts (อัปเดตบ่อย) เป็นหลัก แทน wiki
      return await fetchNasdaq100_Slickcharts_100()
              .catch(async () => await fetchNasdaq100_Wikipedia_100());
    case "altcoins":
      return await fetchOKX_TopUSDT(100, { excludeBlueChips:true }); // ตัด BTC/ETH/Stable
    case "binance_top200":
      return await fetchBinance_TopUSDT(200);
    case "okx_top200":
      return await fetchOKX_TopUSDT(200);
    case "bitkub":
      return await fetchBitkub_AllTHB();
    case "set50":
      return await fetchSET_Wikipedia("set50", 50);
    case "set100":
      return await fetchSET_Wikipedia("set100", 100);
    case "etfs":
      return ETFsTop50();
    case "gold":
      return ["GC=F", "XAUUSD=X"]; // Futures + Spot
    default:
      return [];
  }
}

/* ============================ Equity Indexes ============================ */

// S&P500 (หลัก): slickcharts (ครบ ~500)
async function fetchSP500_Slickcharts_500() {
  const url = "https://www.slickcharts.com/sp500";
  const html = await (await fetch(url, UA())).text();
  const re = /<td class="text-center">([A-Z.\-]{1,7})<\/td>/g;
  const set = new Set();
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set);
  if (arr.length < 450) throw new Error("slickcharts sp500 parse too small");
  return arr.slice(0, 500);
}
async function fetchSP500_Datahub() {
  const url = "https://datahub.io/core/s-and-p-500-companies/r/constituents.json";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`datahub ${r.status}`);
  const js = await r.json();
  const arr = js.map(x => String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
  if (arr.length < 450) throw new Error("datahub sp500 too small");
  return arr.slice(0, 500);
}

// Nasdaq-100: slickcharts → 100 (หลัก) / Wikipedia (รอง)
async function fetchNasdaq100_Slickcharts_100() {
  const url = "https://www.slickcharts.com/nasdaq100";
  const html = await (await fetch(url, UA())).text();
  const re = /<td class="text-center">([A-Z.\-]{1,7})<\/td>/g;
  const set = new Set();
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set);
  if (arr.length < 90) throw new Error("slickcharts nas100 parse too small");
  return arr.slice(0, 100);
}
async function fetchNasdaq100_Wikipedia_100() {
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, UA())).text();
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  const set = new Set();
  let m; while ((m = re.exec(html))) {
    const t = m[1].toUpperCase().replace(/\./g,"-");
    if (/^[A-Z\-]+$/.test(t)) set.add(t);
  }
  const arr = Array.from(set);
  if (arr.length < 90) throw new Error("wiki nas100 parse too small");
  return arr.slice(0, 100);
}

/* ============================ Thailand SET ============================ */
// ใช้ Wikipedia (กึ่งเรียลไทม์ — รายชื่อเปลี่ยนไม่บ่อย) พร้อม regex กว้างขึ้นและ fallback
async function fetchSET_Wikipedia(which, need) {
  const page = which === "set50" ? "SET50_Index" : "SET100_Index";
  const url = `https://en.wikipedia.org/wiki/${page}`;
  const html = await (await fetch(url, UA())).text();

  const set = new Set();
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m; while ((m = re.exec(html))) set.add(m[1].toUpperCase());

  if (set.size < need) {
    const re2 = /<td>\s*([A-Z0-9]{2,6})\s*<\/td>/g;
    while ((m = re2.exec(html))) set.add(m[1].toUpperCase());
  }

  const arr = Array.from(set).filter(x => /^[A-Z0-9]{2,6}$/.test(x));
  return arr.slice(0, need);
}

/* ============================ Crypto – OKX/Binance ============================ */

async function fetchOKX_TopUSDT(n = 100, opts = {}) {
  const url = "https://www.okx.com/api/v5/market/tickers?instType=SPOT";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`okx ${r.status}`);
  const js = await r.json();
  let list = (js.data || []).map(d => ({
    symbol: String(d.instId||"").replace(/-/g,""),
    base: (d.instId||"").split("-")[0],
    quote: (d.instId||"").split("-")[1],
    vol: Number(d.vol24h || d.volCcy24h || 0)
  })).filter(x => x.quote === "USDT");

  list = list.filter(x => !isStable(x.base));
  if (opts.excludeBlueChips) list = list.filter(x => x.base !== "BTC" && x.base !== "ETH");

  list.sort((a,b) => (b.vol - a.vol));
  return uniq(list.map(x => x.symbol)).slice(0, n);
}

async function fetchBinance_TopUSDT(n = 200) {
  const url = "https://api.binance.com/api/v3/ticker/24hr";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`binance ${r.status}`);
  const js = await r.json();

  let list = js.map(d => ({
    symbol: String(d.symbol || ""),
    vol: Number(d.quoteVolume || 0)
  })).filter(x => x.symbol.endsWith("USDT"));

  list = list.filter(x => {
    const base = x.symbol.replace("USDT","");
    return !isStable(base) && !/UPUSDT$|DOWNUSDT$|BULLUSDT$|BEARUSDT$/.test(x.symbol);
  });

  list.sort((a,b) => (b.vol - a.vol));
  return uniq(list.map(x => x.symbol)).slice(0, n);
}

const STABLES = new Set(["USDT","USDC","BUSD","DAI","FDUSD","TUSD","EUR","GBP","TRY","BRL"]);
const isStable = (base) => STABLES.has(base);

/* ============================ Bitkub ============================ */
async function fetchBitkub_AllTHB() {
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

/* ============================ ETFs Top 50 (curated) ============================ */
function ETFsTop50(){
  return [
    "SPY","IVV","VOO","QQQ","VTI","IWM","DIA","EEM","VEA","VTV",
    "VUG","IWF","IWD","XLK","XLF","XLE","XLY","XLC","XLI","XLV",
    "XLU","VNQ","LQD","HYG","AGG","BND","TIP","ARKK","SMH","SOXX",
    "IEMG","SCHD","VIG","IJR","IJH","IWB","IWR","IWN","IWO","IWS",
    "IWP","IJK","IJS","IYC","IYE","IYF","IYH","IYR","TLT","SHY"
  ];
}

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
const UA = () => ({ headers: { "User-Agent": "signal-dashboard/1.0 (+vercel)" } });
function toBool(v){ return ["1","true","yes"].includes(String(v||"").toLowerCase()); }
function clampInt(v, min, max, def){ const n=parseInt(v??"",10); return Number.isFinite(n)? Math.max(min, Math.min(max,n)) : def; }
const uniq = arr => Array.from(new Set((arr||[]).map(s => String(s||"").trim()).filter(Boolean)));
