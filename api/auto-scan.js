// /api/auto-scan.js
import { readJsonFromGitHub } from './_github';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    const settingsPath = process.env.GH_PATH_SETTINGS || 'api/settings.json';
    const auto = await readJsonFromGitHub(settingsPath);
    const groups = Array.isArray(auto?.auto_scan_groups) ? auto.auto_scan_groups : [];

    const results = [];
    for (const g of groups) {
      const url = new URL(`${process.env.NEXT_PUBLIC_API_BASE}/api/run-scan`);
      url.searchParams.set('group', g);
      // auto-scan ไม่ผ่าน manual=1 เพื่อไม่บังคับข้ามพารามิเตอร์ในโค้ด run-scan
      const r = await fetch(url.toString());
      const j = await r.json().catch(() => ({}));
      results.push({ group: g, ok: r.ok, count: Array.isArray(j?.results) ? j.results.length : 0, detail: j });
    }

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
