// api/run-scan.js
// Batch scanner — เดิน cursor ต่อเนื่อง, รวมผลสะสมต่อกลุ่มลง data/signals.json
// เพิ่มความทนทาน: retry ดึง symbols สด, กัน nextCursor เพี้ยน, ส่ง savedCount กลับให้ UI
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual  = ["1","true","yes"].includes((url.searchParams.get("manual")||"").toLowerCase());
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, 250, 25);
    const cursor    = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0);

    // 1) โหลด symbols ของกลุ่ม (สดก่อน, ไม่ได้ค่อย fallback ไฟล์)
    const allSymbols = await getSymbolsForGroupLiveOrFallback(group);
    if (!allSymbols.length) return res.status(400).json({ error: `no symbols for group "${group}"` });

    // 2) สร้าง batch
    const start = isManual ? cursor : 0;
    const end   = Math.min(start + batchSize, allSymbols.length);
    const batch = allSymbols.slice(start, end);

    // 3) สแกน (แทนที่ logic ตรงนี้ด้วยอินดิเคเตอร์จริงของคุณได้เลย)
    const scanned = await scanSymbols(batch);

    // 4) รวมผลกับเดิมและเขียนกลับ
    const mergedPayload = await mergeAndWriteSignals({
      group,
      updatedAt: new Date().toISOString(),
      results: scanned
    });

    // 5) คำนวณ nextCursor ให้ชัดเจน
    const nextCursor = end < allSymbols.length ? end : null;

    res.setHeader("Cache-Control", "no-store");
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
      savedCount: mergedPayload.results.length,
      savedPreview: mergedPayload
    });
  } catch (err) {
    console.error("run-scan error:", err);
    return res.status(500).json({ error: "scan failed", detail: String(err) });
  }
}

/* ========================= Scanner (ใส่อินดี้จริงของคุณได้) =========================
   ตอนนี้เป็น placeholder:
   - 1D  : "Sell"
   - 1W  : "-"  (คุณสามารถเปลี่ยนเป็นอินดิเคเตอร์จริงให้คืนค่า "Buy"/"Sell"/"-")
*/
async function scanSymbols(symbols) {
  // TODO: แทนที่ด้วยการคำนวณอินดิเคเตอร์จริง (ทั้ง 1D และ 1W)
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
  // พยายามดึงสดก่อน (2 ครั้ง), ถ้าไม่ได้ค่อย fallback ไปไฟล์
  for (let i = 0; i < 2; i++) {
    try {
      const live = await getSymbolsLive(group);
      if (Array.isArray(live) && live.length) return uniq(live);
    } catch (e) {
      console.warn(`[symbols-live] ${group} failed(${i+1}):`, e?.message || e);
    }
    await sleep(250);
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
      // หลัก: slickcharts ( ~500 ), สำรอง: datahub
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
      // TODO: เปลี่ยนเป็น OKX API Top 100 USDT ได้ในอนาคต
      return defaultOKXTop100();
    case "okx_top200":
      // TODO: เปลี่ยนเป็น OKX API Top 200 USDT
      return defaultOKXTop200();
    case "binance_top200":
      // TODO: เปลี่ยนเป็น Binance API Top 200 USDT
      return defaultBinanceTop200();
    case "etfs":
      // อัปเดตตามที่คุณขอ
      return [
        "JEPQ","SCHD","QQQ","SPY","VOO","O","IVV","MSTY"
      ];
    case "gold":
      return ["GC=F","XAUUSD=X"]; // Futures + Spot
    default:
      return [];
  }
}

// S&P500 (หลัก): slickcharts
async function fetchSP500Slickcharts() {
  const url = "https://www.slickcharts.com/sp500";
  const html = await (await fetch(url, UA())).text();
  const re = /<td class="text-center">([A-Z.\-]{1,7})<\/td>/g;
  const out = new Set();
  let m;
  while ((m = re.exec(html))) out.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(out);
  if (arr.length < 400) throw new Error("slickcharts parse too small");
  return arr.slice(0, 500);
}
// S&P500 (สำรอง): datahub
async function fetchSP500Datahub() {
  const url = "https://datahub.io/core/s-and-p-500-companies/r/constituents.json";
  const r = await fetch(url, UA());
  if (!r.ok) throw new Error(`datahub ${r.status}`);
  const js = await r.json();
  return js.map(x => String(x.Symbol||"").toUpperCase().replace(/\./g,"-")).filter(Boolean);
}

// Nasdaq100: Wikipedia
async function fetchNasdaq100Wikipedia() {
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set).filter(x => /^[A-Z\-]+$/.test(x));
  if (arr.length < 80) throw new Error("nas100 parse small");
  return arr.slice(0, 100);
}

// SET50/SET100: Wikipedia
async function fetchSETWikipedia(which) {
  const page = which === "set50" ? "SET50_Index" : "SET100_Index";
  const url = `https://en.wikipedia.org/wiki/${page}`;
  const html = await (await fetch(url, UA())).text();
  const set = new Set();
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1].toUpperCase());
  let arr = Array.from(set).filter(x => /^[A-Z]{2,6}$/.test(x));
  if (which === "set50"  && arr.length < 40) throw new Error("set50 parse small");
  if (which === "set100" && arr.length < 80) throw new Error("set100 parse small");
  return arr.slice(0, which === "set50" ? 50 : 100);
}

// Bitkub: API official → THB คู่ (ทั้งหมด)
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

/* =========================== Defaults (ชั่วคราว) =========================== */
function defaultOKXTop100() {
  // **ชั่วคราว 100 ตัวแรก** (โปรดแทนด้วย OKX API จริงเมื่อต้องการ)
  // เพื่อให้ counter ถึง 100/100 แน่ ๆ; ที่นี่ใส่เพียง 20 ตัวเป็นตัวอย่าง
  return [
    "ADAUSDT","APTUSDT","ARBUSDT","ATOMUSDT","AVAXUSDT","BCHUSDT","BNBUSDT","DOGEUSDT",
    "DOTUSDT","ETCUSDT","FILUSDT","LINKUSDT","LTCUSDT","MATICUSDT","NEARUSDT","OPUSDT",
    "SANDUSDT","SOLUSDT","SUIUSDT","XRPUSDT"
  ];
}
function defaultOKXTop200() {
  // ชั่วคราวเหมือนกัน (ขั้นต่ำ 20 ให้เห็นการทำงาน)
  return defaultOKXTop100();
}
function defaultBinanceTop200() {
  // ชั่วคราวเหมือนกัน (ขั้นต่ำ 20 ให้เห็นการทำงาน)
  return defaultOKXTop100();
}

/* ================================ GitHub I/O =============================== */
async function ghReadJSON(path, repo, branch) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op: "read", path, repo: repo||"", branch: branch||"" }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetch(url, { headers: { "Cache-Control": "no-store" }});
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

/** รวมผลสะสมต่อกลุ่ม (key = ticker) แล้วเขียนทับ data/signals.json */
async function mergeAndWriteSignals(payload) {
  const repo   = process.env.GH_REPO || process.env.GH_REPO_SYMBOLS;
  const branch = process.env.GH_BRANCH || "main";
  const path   = process.env.GH_PATH_SIGNALS || "data/signals.json";

  let prev = {};
  try {
    prev = await ghReadJSON(path, repo, branch);
  } catch { /* ignore */ }

  // ถ้าไฟล์เดิมเป็นกลุ่มเดียวกันให้รวม; ถ้าคนละกลุ่มเริ่มใหม่
  const map = new Map();
  if (prev?.group === payload.group && Array.isArray(prev?.results)) {
    for (const r of prev.results) map.set(r.ticker, r);
  }
  for (const r of payload.results) map.set(r.ticker, r);

  const merged = {
    group: payload.group,
    updatedAt: payload.updatedAt,
    results: Array.from(map.values())
  };

  await ghWrite(path, repo, branch, JSON.stringify(merged, null, 2), `update data/signals.json`);
  return merged;
}

/* ================================= Utils ================================== */
const UA = () => ({ headers: { "User-Agent": "signal-dashboard/1.0" } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function clampInt(v, min, max, def) {
  const n = parseInt(v ?? "", 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}
const uniq = arr => Array.from(new Set((arr||[]).map(s => String(s||"").trim()).filter(Boolean)));
