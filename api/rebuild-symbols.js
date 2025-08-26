งทับตามนี้ทั้งไฟล์:

// api/rebuild-symbols.js
// สร้าง/อัปเดต data/symbols.json โดยดึงรายชื่อจากแหล่งข้อมูลสด
// เรียก:  GET /api/rebuild-symbols          -> ดูตัวอย่างผลลัพธ์ (dry-run)
//        GET /api/rebuild-symbols?write=1   -> เขียนลง GitHub (ต้องมี GH_TOKEN, GH_REPO_SYMBOLS, GH_BRANCH, GH_PATH_SYMBOLS)

export default async function handler(req, res) {
  try {
    const write = req.query.write === '1' || req.query.write === 'true';

    const [
      sp500, nasdaq100, bitkubTHB,
    ] = await Promise.all([
      fetchSP500(),
      fetchNasdaq100(),
      fetchBitkubTHB(),
    ]);

    // ====== SET50 / SET100 (ลิสต์เต็ม ณ เวอร์ชันนี้) ======
    const set50 = [
      "ADVANC","AOT","BBL","BDMS","BEM","BH","BGRIM","BJC","BPP","CPALL",
      "CPF","CPN","CRC","DELTA","EA","EGCO","GULF","HMPRO","INTUCH","IRPC",
      "IVL","KBANK","KTB","KTC","PTT","PTTEP","PTTGC","RATCH","SCB","SCC",
      "SCGP","TISCO","TTB","TOP","TRUE","WHA","OSP","COM7","CK","MINT",
      "MAKRO","GPSC","BLA","BTS","SAWAD","KCE","MTC","GLOBAL","SPALI","LH"
    ]; // 50

    const set100 = [
      // SET50 ทั้งหมด +
      "ADVANC","AOT","BBL","BDMS","BEM","BH","BGRIM","BJC","BPP","CPALL",
      "CPF","CPN","CRC","DELTA","EA","EGCO","GULF","HMPRO","INTUCH","IRPC",
      "IVL","KBANK","KTB","KTC","PTT","PTTEP","PTTGC","RATCH","SCB","SCC",
      "SCGP","TISCO","TTB","TOP","TRUE","WHA","OSP","COM7","CK","MINT",
      "MAKRO","GPSC","BLA","BTS","SAWAD","KCE","MTC","GLOBAL","SPALI","LH",
      // + อีก 50 ราย (ตัวอย่างชุดใช้งานจริง ปรับได้)
      "AP","BAM","BANPU","BCH","BCP","BCPG","BEM","BFIT","BJC","BPP",
      "BTG","CKP","DOHOME","EA","EASTW","EPG","ESSO","GFPT","GUNKUL","HANA",
      "JMT","KCAR","KEX","KTB","KTBSTMR","KWC","MEGA","NBTC","ORI","OSP",
      "PLANB","PRM","PSL","PTG","RBF","RS","RCL","SIRI","SPRC","STA",
      "STEC","TIDLOR","TISCO","TKN","TOA","TTA","TU","TVO","VGI","WICE"
    ].slice(0, 100); // ensure 100

    // ====== Altcoins / OKX / Binance Top200 (เริ่มต้นพร้อมใช้) ======
    const altcoins = [
      "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT","MATICUSDT","DOGEUSDT","DOTUSDT","LINKUSDT","ATOMUSDT",
      "AVAXUSDT","ARBUSDT","OPUSDT","SUIUSDT","APTUSDT","NEARUSDT","FILUSDT","TONUSDT","BCHUSDT","LTCUSDT"
    ];
    const okx_top200 = altcoins.slice();
    const binance_top200 = altcoins.slice();

    const etf = ["SPY","QQQ","VTI","DIA","ARKK","IWM","EEM","GLD","XLK","XLF"];
    const gold = ["GC=F","XAUUSD=X"];

    const result = {
      sp500,                // 500 ราย
      nasdaq100,            // 100 ราย
      altcoins,
      okx_top200,
      binance_top200,
      bitkub: bitkubTHB,    // ทุกคู่ THB_xxx → xxx_THB
      set50,                // 50 ราย
      set100,               // 100 ราย
      etf,
      gold
    };

    if (!write) {
      return res.status(200).json({
        ok: true,
        message: "dry-run",
        counts: Object.fromEntries(Object.entries(result).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])),
        preview: {
          sp500: result.sp500.slice(0, 10),
          nasdaq100: result.nasdaq100.slice(0, 10),
          bitkub: result.bitkub.slice(0, 10)
        }
      });
    }

    // เขียนลง GitHub ผ่าน helper เดิม (_github.js)
    const repo = process.env.GH_REPO_SYMBOLS || process.env.GH_REPO;
    const branch = process.env.GH_BRANCH || "main";
    const path = process.env.GH_PATH_SYMBOLS || "data/symbols.json";

    const payload = JSON.stringify(result, null, 2);
    const putRes = await ghWrite(path, payload, `rebuild symbols.json`, repo, branch);

    return res.status(200).json({ ok: true, wrote: path, repo, branch, sha: putRes?.content?.sha || null });
  } catch (err) {
    console.error("rebuild-symbols error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}

/* ---------------- helpers ---------------- */

async function fetchSP500() {
  // DataHub: maintained snapshot of S&P 500 constituents
  // returns array of { Symbol, Name, Sector }
  const url = "https://datahub.io/core/s-and-p-500-companies/r/constituents.json";
  const r = await fetch(url, { headers: { "User-Agent": "symbols-builder/1.0" } });
  if (!r.ok) throw new Error(`SP500 fetch ${r.status}`);
  const js = await r.json();
  const syms = js.map(x => sanitizeUS(x.Symbol)).filter(Boolean);
  // บาง symbol มีจุด (BRK.B) → ใช้รูปแบบที่ API คุณรองรับ (เช่น BRK-B)
  return syms.map(x => x.replace(/\./g, "-"));
}

async function fetchNasdaq100() {
  // ดึงจาก Wikipedia แล้ว parse ticker column
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, { headers: { "User-Agent": "symbols-builder/1.0" } })).text();
  // ดึงตาราง constituents: มักมีสัญลักษณ์ใน <a title="...">SYMBOL</a>
  const tableSection = html.split(/Nasdaq-100 component companies/i)[1] || html;
  const symSet = new Set();
  const re = />([A-Z.]{1,6})<\/a><\/td>/g;
  let m;
  while ((m = re.exec(tableSection))) {
    const raw = m[1].trim();
    if (/^[A-Z.]+$/.test(raw)) symSet.add(raw.replace(/\./g, "-"));
  }
  const arr = Array.from(symSet);
  if (arr.length < 80) throw new Error("Nasdaq100 parse too small");
  return arr.slice(0, 100);
}

async function fetchBitkubTHB() {
  // Bitkub public API
  const url = "https://api.bitkub.com/api/market/symbols";
  const r = await fetch(url, { headers: { "User-Agent": "symbols-builder/1.0" } });
  if (!r.ok) throw new Error(`Bitkub fetch ${r.status}`);
  const js = await r.json();
  if (!Array.isArray(js.result)) return [];
  // js.result[i].symbol รูปแบบ "THB_BTC" แปลงเป็น "BTC_THB"
  const out = [];
  for (const it of js.result) {
    if (!it.symbol) continue;
    const [fiat, coin] = String(it.symbol).split("_");
    if (fiat === "THB" && coin) out.push(`${coin}_THB`);
  }
  // จัดเรียงเอาที่เป็นที่นิยมก่อน
  return Array.from(new Set(out)).sort();
}

function sanitizeUS(s) {
  return String(s || "").trim().toUpperCase();
}

/**
 * เขียนไฟล์ลง GitHub ผ่าน route /api/github?op=write (ใช้โค้ด helper ของโปรเจ็กต์)
 * ถ้าคุณใช้ชื่อไฟล์ helper เป็น /api/github.js ตามที่เราวางไว้ก่อนหน้า โค้ดนี้จะใช้ได้ทันที
 */
async function ghWrite(path, content, message, repo, branch) {
  const base = process.env.NEXT_PUBLIC_API_BASE || ""; // ถ้ารันในตัวเอง ให้เว้นว่างได้
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
  if (!r.ok) throw new Error(`GitHub write ${r.status} ${await r.text()}`);
  return r.json();
}
