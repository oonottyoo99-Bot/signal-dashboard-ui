// api/run-scan.js
// Manual/Batch scan ที่อ่าน "รายชื่อสัญลักษณ์" สดจากแหล่งข้อมูลจริง
// รองรับกลุ่ม: sp500, nasdaq100, altcoins, okx_top200, binance_top200, bitkub, set50, set100, etfs, gold
// ใช้:  GET /api/run-scan?group=sp500&manual=1
//  - จะสแกนทีละ batch (ค่าเริ่มต้น 25) และคืน nextCursor ให้หน้าเว็บไล่ยิงต่อจนจบ
//  - ถ้าต้องการสแกนทั้งชุดในทีเดียว: /api/run-scan?group=sp500&manual=1&batchSize=9999

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    const isManual = url.searchParams.get("manual") === "1" || url.searchParams.get("manual") === "true";
    const batchSize = clampInt(url.searchParams.get("batchSize"), 1, 200, 25);
    const cursor = clampInt(url.searchParams.get("cursor"), 0, 1e9, 0); // index เริ่มสแกน

    // 1) ดึง "รายชื่อ" สดจากแหล่งข้อมูล (ถ้าล้มเหลว จะ fallback ไป data/symbols.json)
    const symbolsAll = await getSymbolsForGroupLiveOrFallback(group);
    if (!symbolsAll || symbolsAll.length === 0) {
      return res.status(400).json({ error: `no symbols for group "${group}"` });
    }

    // 2) ตัด batch ที่จะสแกนรอบนี้
    const start = isManual ? cursor : 0;
    const end = isManual ? Math.min(start + batchSize, symbolsAll.length) : Math.min(batchSize, symbolsAll.length);
    const symbolsBatch = symbolsAll.slice(start, end);

    // 3) สแกน (ตัวอย่าง: ใส่ logic indicator จริงของคุณได้เลย)
    const results = await scanSymbols(symbolsBatch);

    // 4) รวมผลล่าสุดและเขียน signals.json (เก็บเฉพาะ batch ที่สแกนแล้ว)
    const finalPayload = {
      group,
      updatedAt: new Date().toISOString(),
      results
    };
    await writeSignals(finalPayload);

    // 5) ตอบกลับพร้อมตัวชี้วัด batch
    const nextCursor = end < symbolsAll.length ? end : null;
    return res.status(200).json({
      group,
      total: symbolsAll.length,
      processed: results.length,
      start,
      end: end - 1,
      nextCursor,              // ให้หน้าเว็บยิง /api/run-scan?cursor=<ค่านี้>&manual=1 ต่อจนกว่าจะ null
      batchSize,
      results
    });
  } catch (err) {
    console.error("run-scan error:", err);
    return res.status(500).json({ error: "scan failed", detail: String(err) });
  }
}

/* =============================== Core Scanner =============================== */

// TODO: แทนที่ logic นี้ด้วยอินดิเคเตอร์จริงของคุณ
// คืนทั้ง 1D และ 1W (หน้าเว็บคุณจะแสดง 2 คอลัมน์อยู่แล้ว)
async function scanSymbols(symbols) {
  // ตัวอย่าง: ทำเป็น "Sell" ชั่วคราว และ price = null
  // คุณสามารถ fetch ราคาจริง/คำนวณอินดิเคเตอร์ที่นี่ แล้วให้ signalD / signalW ต่างกันได้
  return symbols.map(ticker => ({
    ticker,
    signalD: "Sell",
    signalW: "-",      // ถ้าอินดิเคเตอร์ 1W มีสัญญาณ ให้ใส่ "Buy"/"Sell" ตรงนี้
    price: null,
    timeframe: "1D"
  }));
}

/* ============================ Live Symbols fetch ============================ */

async function getSymbolsForGroupLiveOrFallback(group) {
  try {
    const live = await getSymbolsLive(group);
    if (Array.isArray(live) && live.length) return uniqueStrings(live);
  } catch (e) {
    console.warn(`[symbols-live] ${group} failed:`, e?.message || e);
  }
  // fallback → data/symbols.json
  try {
    const json = await ghReadJSON(process.env.GH_PATH_SYMBOLS || "data/symbols.json", process.env.GH_REPO_SYMBOLS || process.env.GH_REPO, process.env.GH_BRANCH || "main");
    const arr = Array.isArray(json?.[group]) ? json[group] : [];
    return uniqueStrings(arr);
  } catch (e2) {
    console.warn(`[symbols-fallback] ${group} failed:`, e2?.message || e2);
    return [];
  }
}

async function getSymbolsLive(group) {
  switch (group) {
    case "sp500":
      return await fetchSP500();            // 500
    case "nasdaq100":
      return await fetchNasdaq100();        // 100
    case "bitkub":
      return await fetchBitkubTHB();        // ทั้งหมดคู่ THB:  BTC_THB, ETH_THB, ...
    case "set50":
      return await fetchSET("set50");       // 50 (สดจาก Wikipedia; ถ้า DOM เปลี่ยนจะ fallback)
    case "set100":
      return await fetchSET("set100");      // 100
    case "altcoins":
      return defaultAltcoins();
    case "okx_top200":
      return defaultOKX();
    case "binance_top200":
      return defaultBinance();
    case "etfs":
      return ["SPY","QQQ","VTI","DIA","ARKK","IWM","EEM","GLD","XLK","XLF"];
    case "gold":
      return ["GC=F","XAUUSD=X"];
    default:
      return [];
  }
}

/* ----------------------- Fetchers (live from the web) ---------------------- */

async function fetchSP500() {
  // DataHub: maintained S&P500 constituents
  const url = "https://datahub.io/core/s-and-p-500-companies/r/constituents.json";
  const r = await fetch(url, { headers: { "User-Agent": "signal-dashboard/1.0" } });
  if (!r.ok) throw new Error(`SP500 fetch ${r.status}`);
  const js = await r.json();
  // Convert "BRK.B" → "BRK-B"
  return js.map(x => String(x.Symbol || "").toUpperCase().replace(/\./g, "-")).filter(Boolean);
}

async function fetchNasdaq100() {
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, { headers: { "User-Agent": "signal-dashboard/1.0" } })).text();
  const symSet = new Set();
  // จับ symbol ที่เป็นลิงก์ในตาราง constituents
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const s = m[1].trim().toUpperCase().replace(/\./g, "-");
    if (/^[A-Z\-]+$/.test(s)) symSet.add(s);
  }
  const arr = Array.from(symSet);
  if (arr.length < 80) throw new Error("Nasdaq100 parse too small");
  return arr.slice(0, 100);
}

async function fetchSET(which) {
  // Wikipedia pages: SET50 Index / SET100 Index
  const url = which === "set50"
    ? "https://en.wikipedia.org/wiki/SET50_Index"
    : "https://en.wikipedia.org/wiki/SET100_Index";
  const html = await (await fetch(url, { headers: { "User-Agent": "signal-dashboard/1.0" } })).text();
  // หา Ticker (A-Z/0-9) 2–6 ตัวในตารางหลัก
  const symSet = new Set();
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    symSet.add(m[1].trim().toUpperCase());
  }
  let arr = Array.from(symSet);
  // กันพลาด: ถ้าน้อยไปมาก ๆ ให้โยน error เพื่อให้ fallback ไปไฟล์
  if (which === "set50" && arr.length < 40) throw new Error("SET50 parse too small");
  if (which === "set100" && arr.length < 80) throw new Error("SET100 parse too small");

  // Wikipedia อาจมี noise → กรองชื่อที่เข้า pattern หุ้นไทยทั่วไป (A–Z 2–6 ตัว)
  arr = arr.filter(x => /^[A-Z]{2,6}$/.test(x));
  // limit จำนวนที่ต้องการ
  arr = arr.slice(0, which === "set50" ? 50 : 100);
  return arr;
}

async function fetchBitkubTHB() {
  const url = "https://api.bitkub.com/api/market/symbols";
  const r = await fetch(url, { headers: { "User-Agent": "signal-dashboard/1.0" } });
  if (!r.ok) throw new Error(`Bitkub fetch ${r.status}`);
  const js = await r.json();
  if (!Array.isArray(js?.result)) return [];
  const out = [];
  for (const it of js.result) {
    const raw = String(it.symbol || "");
    // รูปแบบ "THB_BTC" → "BTC_THB"
    const [fiat, coin] = raw.split("_");
    if (fiat === "THB" && coin) out.push(`${coin}_THB`);
  }
  return uniqueStrings(out).sort();
}

/* -------------------------- Defaults for crypto ---------------------------- */

function defaultAltcoins() {
  return [
    "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT","MATICUSDT","DOGEUSDT","DOTUSDT","LINKUSDT","ATOMUSDT",
    "AVAXUSDT","ARBUSDT","OPUSDT","SUIUSDT","APTUSDT","NEARUSDT","FILUSDT","TONUSDT","BCHUSDT","LTCUSDT"
  ];
}
function defaultOKX() { return defaultAltcoins(); }
function defaultBinance() { return defaultAltcoins(); }

/* ================================ GitHub I/O ================================ */

// อ่านไฟล์ JSON จาก repo ผ่าน helper route /api/github?op=read
async function ghReadJSON(path, repo, branch) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op: "read", path, repo: repo || "", branch: branch || "" }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ghRead ${r.status} ${await r.text()}`);
  return r.json();
}

// เขียน signals.json (บันทึกผลล่าสุดสำหรับหน้า /api/signals)
async function writeSignals(payload) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const repo = process.env.GH_REPO || process.env.GH_REPO_SYMBOLS;
  const branch = process.env.GH_BRANCH || "main";
  const path = process.env.GH_PATH_SIGNALS || "data/signals.json";

  const qs = new URLSearchParams({ op: "write", path, repo: repo || "", branch }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: JSON.stringify(payload, null, 2), message: `update signals ${payload.group}` })
  });
  if (!r.ok) throw new Error(`ghWrite ${r.status} ${await r.text()}`);
  return r.json();
}

/* ================================= Utils ================================== */

function clampInt(v, min, max, def) {
  const n = parseInt(v ?? "", 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}
function uniqueStrings(arr) {
  return Array.from(new Set((arr || []).map(s => String(s || "").trim()).filter(Boolean)));
}
