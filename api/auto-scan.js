// api/auto-scan.js
const BASE = process.env.NEXT_PUBLIC_API_BASE || `https://${process.env.VERCEL_URL}`;

async function call(path) {
  const url = `${BASE}${path}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json().catch(()=> ({}));
}

export default async function handler(req, res) {
  try {
    // อ่าน settings เพื่อรู้ว่าเปิด auto-scan กลุ่มไหนบ้าง
    const s = await call(`/api/settings`);
    const groups = Array.isArray(s?.auto_scan_groups) ? s.auto_scan_groups : [];

    if (!groups.length) {
      res.status(200).json({ ok:false, error:'no groups enabled in settings' });
      return;
    }

    const results = [];
    for (const g of groups) {
      try {
        const j = await call(`/api/run-scan?group=${encodeURIComponent(g)}`);
        results.push({ group: g, ok: true, count: j?.results?.length || 0 });
      } catch (e) {
        results.push({ group: g, ok: false, error: String(e) });
      }
    }
    res.status(200).json({ ok:true, results });
  } catch (e) {
    res.status(500).json({ ok:false, error: `read settings failed: ${String(e)}` });
  }
}
