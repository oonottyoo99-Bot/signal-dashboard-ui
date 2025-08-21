// api/auto-scan.js
// ------------------------------------------------------
// รันสแกนหลายกลุ่มอัตโนมัติ โดยอ่านกลุ่มจาก settings.json
// - ใช้ NEXT_PUBLIC_API_BASE เพื่อเรียก endpoint ในโปรเจ็กต์นี้เอง
// - รองรับ query ?manual=1 เพื่อบังคับข้ามการเช็คสวิตช์ (debug)
// ------------------------------------------------------

const BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

function parseBool(v) {
  return v === "1" || v === "true" || v === true;
}

async function callJSON(path) {
  const url = `${BASE}${path}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json().catch(() => ({}));
}

export default async function handler(req, res) {
  try {
    if (!BASE) {
      return res.status(500).json({
        ok: false,
        error: "NEXT_PUBLIC_API_BASE is not set and VERCEL_URL unavailable",
      });
    }

    // โหลด settings เพื่อทราบว่าเปิด auto-scan กลุ่มไหน
    const settings = await callJSON(`/api/settings`);
    const groups = Array.isArray(settings?.auto_scan_groups)
      ? settings.auto_scan_groups
      : [];

    if (!groups.length) {
      return res.status(200).json({
        ok: false,
        error: "no groups enabled in settings",
      });
    }

    const manual = parseBool(req.query.manual); // ถ้าส่ง manual=1 จะต่อให้ run-scan ข้ามสวิตช์

    const results = [];
    for (const g of groups) {
      const qs = manual ? `?group=${encodeURIComponent(g)}&manual=1` : `?group=${encodeURIComponent(g)}`;
      try {
        const payload = await callJSON(`/api/run-scan${qs}`);
        results.push({
          group: g,
          ok: true,
          count: Array.isArray(payload?.results) ? payload.results.length : 0,
        });
      } catch (e) {
        results.push({ group: g, ok: false, error: String(e) });
      }
    }

    res.status(200).json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: `read settings failed: ${String(e)}` });
  }
}
