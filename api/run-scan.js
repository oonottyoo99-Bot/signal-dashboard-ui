// /api/run-scan.js
// โลจิก: 
// - manual=1 ข้ามสวิตช์ Auto-Scan
// - อ่าน data/symbols.json เพื่อดึง list ตาม group
// - อ่าน settings.json เพื่อดูสวิตช์ (auto scan groups)
// - สแกนแบบ mock ให้ผลเฉพาะ BUY/STRONGBUY เท่านั้น
// - เขียนผลลง GH_PATH_SIGNALS

const GH_READ  = "/api/_github?op=read&path=";
const GH_WRITE = "/api/_github";

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers.host;
  return `${proto}://${host}`;
}

async function ghRead(req, path) {
  const r = await fetch(`${baseUrl(req)}${GH_READ}${encodeURIComponent(path)}`, { next: { revalidate: 0 }});
  if (!r.ok) throw new Error(`ghRead ${path} -> HTTP ${r.status}`);
  return await r.text();
}

async function ghWrite(req, path, objOrText) {
  const body = typeof objOrText === "string" ? objOrText : JSON.stringify(objOrText, null, 2);
  const r = await fetch(`${baseUrl(req)}${GH_WRITE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "write", path, content: body }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`ghWrite ${path} -> HTTP ${r.status} ${t}`);
  }
  return await r.json();
}

// --------- MOCK SIGNAL (แทนอินดิเคเตอร์จริงชั่วคราว) ----------
function mockSignalFor(ticker) {
  // กระจายโอกาสให้มี BUY/STRONGBUY บ้าง
  const h = [...ticker].reduce((a, c) => a + c.charCodeAt(0), 0);
  const r = (h % 10);
  if (r === 0) return { signal: "STRONGBUY", tf: "1D" };
  if (r === 1) return { signal: "BUY", tf: "1D" };
  if (r === 2) return { signal: "BUY", tf: "1W" };
  // อื่นๆ ไม่ส่งสัญญาณ
  return { signal: "-", tf: "1D" };
}
// ---------------------------------------------------------------

export default async function handler(req, res) {
  try {
    const group   = (req.query.group || "").toLowerCase(); // sp500, nasdaq100, ฯลฯ
    const manual  = req.query.manual === "1";
    const {
      GH_PATH_SIGNALS = process.env.GH_PATH_SIGNALS || "api/signals.json",
      GH_PATH_SETTINGS = process.env.GH_PATH_SETTINGS || "api/settings.json",
    } = process.env;

    if (!group) return res.status(400).json({ error: "ต้องใส่ ?group=..." });

    // 1) อ่าน settings เพื่อตรวจสวิตช์ auto-scan (ถ้าไม่ manual)
    let settings = { auto_scan_groups: [] };
    try {
      const sRaw = await ghRead(req, GH_PATH_SETTINGS);
      settings = JSON.parse(sRaw || "{}");
    } catch (e) {
      // ยังไม่มี settings.json ถือว่า []
    }
    if (!manual) {
      const enabled = settings.auto_scan_groups || [];
      if (!enabled.includes(group)) {
        return res.status(200).json({ skipped: true, reason: `auto-scan ของ "${group}" ปิดอยู่` });
      }
    }

    // 2) โหลดรายชื่อสัญลักษณ์จาก data/symbols.json
    const symRaw = await ghRead(req, "data/symbols.json");
    const SYMS = JSON.parse(symRaw);
    const list = SYMS[group];
    if (!Array.isArray(list) || list.length === 0) {
      return res.status(400).json({ error: `ไม่พบกลุ่ม ${group} ใน data/symbols.json` });
    }

    // 3) (ชั่วคราว) สแกนแบบ mock และ "คัดเฉพาะ" BUY / STRONGBUY
    const out = [];
    for (const tk of list) {
      const m = mockSignalFor(tk);
      if (m.signal === "BUY" || m.signal === "STRONGBUY") {
        // ให้มี price mock ไว้ก่อน
        out.push({
          ticker: tk,
          signal: m.signal,
          price: Number((100 + Math.random() * 900).toFixed(2)),
          timeframe: m.tf,
        });
      }
    }

    // 4) บันทึกผลลง signals.json (รูปแบบเดียวกับ UI อ่าน)
    const payload = {
      group,
      updatedAt: new Date().toISOString(),
      results: out,
    };
    await ghWrite(req, GH_PATH_SIGNALS, payload);

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: "scan failed", detail: String(e.message || e) });
  }
}
