// api/run-scan.js
// Batch scanner + live symbols + append/merge to signals.json (per group)
// - เพิ่มการดึงรายชื่อครบจริง (slickcharts paginate / exchange APIs)
// - จัดอันดับด้วย volume สำหรับ crypto
// - คงรูปแบบ response เดิม: { ok, group, total, processed, start, end, nextCursor, batchSize, results, savedPreview }

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual  = ["1","true","yes"].includes((url.searchParams.get("manual")||"").toLowerCase());
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, 500, 50);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);

    // 1) ดึงรายชื่อแบบ live (มีสำรอง) ให้ได้ชุด "เต็มจริง"
    const allSymbols = await getSymbolsForGroupLiveOrFallback(group);
    if (!allSymbols.length) return res.status(400).json({ error: `no symbols for group "${group}"` });

    // 2) ตัด batch (manual จะเดิน cursor ต่อ; auto จะเริ่มที่ 0 ทุกครั้ง)
    const start = isManual ? cursor : 0;
    const end   = Math.min(start + batchSize, allSymbols.length);
    const batch = allSymbols.slice(start, end);

    // 3) สแกนอินดิเคเตอร์ (placeholder – ใส่ logic จริงของคุณได้เลย)
    const scanned = await scanSymbols(batch);

    // 4) รวมผล & บันทึกกลับ
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
    return uniq(Array.isArray(json?.[group]) ? json[group] : []);
  } catch (e2) {
    console.warn(`[symbols-fallback] ${group} failed:`, e2?.message || e2);
    return [];
  }
}

async function getSymbolsLive(group) {
  switch (group) {
    case "sp500":
      return await fetchSlickchartsPaged("sp500", 10, 500);   // 10 หน้าเผื่อขยาย
    case "nasdaq100":
      // แหล่งหลัก slickcharts (มีแบ่งหน้าเหมือนกัน), สำรอง wikipedia
      return await fetchSlickchartsPaged("nasdaq100", 5, 100)
        .catch(async () => await fetchNasdaq100Wikipedia());
    case "binance_top200":
      return await fetchBinanceTopByVolume(200);
    case "okx_top200":
      return await fetchOkxTopByVolume(200);
    case "altcoins":
      return await fetchOkxTopByVolume(100, { exclude: ["BTC","ETH","USDT","USDC","FDUSD","DAI","TUSD"] });
    case "bitkub":
      return await fetchBitkubTHB();
    case "set50":
      return await fetchSETWikipedia("set50");
    case "set100":
      return await fetchSETWikipedia("set100");
    case "etfs":
      return curatedETFs();
    case "gold":
      return ["GC=F","XAUUSD=X"]; // Futures + Spot
    default:
      return [];
  }
}

/* ============================ Slickcharts (paged) ============================ */

// ตัวอย่าง: https://www.slickcharts.com/sp500?page=1
async function fetchSlickchartsPaged(path, maxPages, hardCap) {
  const all = new Set();
  for (let p = 1; p <= maxPages; p++) {
    const url = `https://www.slickcharts.com/${path}?page=${p}`;
    const html = await (await fetch(url, UA())).text();

    // ดึง symbol จากคอลัมน์ Symbol (class อาจต่างกันในบางหน้า ใช้ regex ที่ยืดหยุ่น)
    const re = /<td[^>]*>\s*([A-Z][A-Z0-9.\-]{0,6})\s*<\/td>\s*<td[^>]*>\s*[A-Za-z]/g;
    let m, countBefore = all.size;
    while ((m = re.exec(html))) {
      const sym = m[1].toUpperCase().replace(/\./g,"-");
      if (/^[A-Z0-9\-]{1,7}$/.test(sym)) all.add(sym);
    }
    // ถ้าหน้านี้ไม่เพิ่มอะไรแล้ว → หยุด
    if (all.size === countBefore) break;
    if (all.size >= hardCap) break;
  }
  return Array.from(all).slice(0, hardCap);
}

/* ============================ Wikipedia (สำรอง) ============================ */

async function fetchNasdaq100Wikipedia() {
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, UA())).text();
  const set = new Set();

  // จับเฉพาะคอลัมน์ "Ticker" ในตาราง constituents
  // หา row ที่มี 'Ticker' ใน header ใกล้ ๆ
  const tableMatch = html.match(/<table[^>]*?wikitable[^>]*>[\s\S]*?<\/table>/g) || [];
  for (const tb of tableMatch) {
    if (!/Ticker/i.test(tb) || !/Company|Weight|Sector/i.test(tb)) continue;
    const re = /<td[^>]*>\s*([A-Z.\-]{1,7})\s*<\/td>/g;
    let m;
    while ((m = re.exec(tb))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  }
  const arr = Array.from(set).filter(x => /^[A-Z0-9\-]+$/.test(x));
  if (arr.length < 80) throw new Error("nasdaq100 wikipedia parse small");
  return arr.slice(0, 100);
}

// SET50/SET100 จาก Wikipedia (ปรับ regex ให้เก็บเฉพาะรหัสหุ้น)
async function fetchSETWikipedia(which) {
  const page = which === "set50" ? "SET50_Index" : "SET100_Index";
  const url = `https://en.wikipedia.org/wiki/${page}`;
  const html = await (await fetch(url, UA())).text();
  const set = new Set();

  // รหัสหุ้นไทยเป็น [A-Z]{2,6} ใน cell ตัวแรกของแถว constituents
  const re = /<td[^>]*>\s*([A-Z]{2,6})\s*<\/td>\s*<td[^>]*>\s*[A-Za-z]/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1].toUpperCase());
  let arr = Array.from(set).filter(x => /^[A-Z]{2,6}$/.test(x));
  if (which === "set50"  && arr.length < 45)  throw new Error("set50 parse small");
  if (which === "set100" && arr.length < 90)  throw new Error("set100 parse small");
  return arr.slice(0, which === "set50" ? 50 : 100);
}

/* ============================ Crypto: Top by Volume ============================ */

// Binance: เอาคู่ USDT spot ที่ status = TRADING, sort ตาม quoteVolume 24h แล้วตัด stablecoins
async function fetchBinanceTopByVolume(limit = 200) {
  const exInfo = await (await fetch("https://api.binance.com/api/v3/exchangeInfo", UA())).json();
  const tick24 = await (await fetch("https://api.binance.com/api/v3/ticker/24hr", UA())).json();

  const valid = new Set(
    exInfo.symbols
      .filter(s => s.status === "TRADING" && s.quoteAsset === "USDT")
      .map(s => s.symbol) // เช่น BTCUSDT
  );

  // map -> volume
  const volMap = new Map();
  for (const t of tick24) {
    if (!valid.has(t.symbol)) continue;
    const v = Number(t.quoteVolume || 0);
    if (Number.isFinite(v)) volMap.set(t.symbol, v);
  }

  const excluded = new Set(["USDT","USDC","FDUSD","TUSD","DAI","BUSD"]);
  const sorted = Array.from(volMap.entries())
    .filter(([sym]) => {
      const base = sym.replace(/USDT$/,"");
      return !excluded.has(base);
    })
    .sort((a,b) => b[1] - a[1])
    .slice(0, limit)
    .map(([sym]) => sym);

  return sorted;
}

// OKX: เอาคู่ USDT spot จาก /market/tickers?instType=SPOT แล้ว sort ตาม volCcy 24h
async function fetchOkxTopByVolume(limit = 200, opt = {}) {
  const r = await (await fetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT", UA())).json();
  const excluded = new Set(["USDT","USDC","DAI","TUSD","FDUSD","BUSD","UST","USD"]);
  if (Array.isArray(opt?.exclude)) for (const x of opt.exclude) excluded.add(String(x).toUpperCase());

  const arr = [];
  for (const it of r?.data || []) {
    const instId = String(it.instId || ""); // eg: BTC-USDT
    if (!/USDT$/i.test(instId)) continue;
    const base = instId.split("-")[0].toUpperCase();
    if (excluded.has(base)) continue;
    const vol = Number(it.volCcy || it.vol24h || 0);
    if (Number.isFinite(vol)) arr.push([instId.replace("-","")/*BTCUSDT*/, vol]);
  }

  return arr.sort((a,b)=>b[1]-a[1]).slice(0, limit).map(x => x[0]);
}

/* ============================ Bitkub ============================ */

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

/* ============================ ETFs (curated 50) ============================ */

function curatedETFs() {
  return [
    "SPY","VOO","IVV","VTI","SCHB","IWM","QQQ","VUG","VTV","DIA",
    "EEM","VEA","VXUS","IEFA","IEMG","XLF","XLK","XLY","XLP","XLE",
    "XLI","XLV","XLU","VNQ","VNQI","ARKK","SMH","SOXX","XBI","IBB",
    "TLT","IEF","SHY","LQD","HYG","BND","AGG","TIP","GLD","SLV",
    "USO","UNG","XOP","XME","XHB","ITA","IYR","IYT","IHI","KRE"
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
  } catch {/* ignore */}

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

const UA = () => ({ headers: { "User-Agent": "signal-dashboard/1.0" } });

function clampInt(v, min, max, def) {
  const n = parseInt(v ?? "", 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}
const uniq = arr => Array.from(new Set((arr||[]).map(s => String(s||"").trim()).filter(Boolean)));
