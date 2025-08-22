// /api/auto-scan.js
import { readJsonFromGitHub } from './github';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    const settingsPath = process.env.GH_PATH_SETTINGS || 'api/settings.json';
    const settings = await readJsonFromGitHub(settingsPath); // จาก repo หลัก
    const groups = Array.isArray(settings?.auto_scan_groups) ? settings.auto_scan_groups : [];

    const out = [];
    for (const g of groups) {
      const url = new URL(`${process.env.NEXT_PUBLIC_API_BASE}/api/run-scan`);
      url.searchParams.set('group', g);
      const r = await fetch(url.toString());
      const j = await r.json().catch(() => ({}));
      out.push({ group: g, ok: r.ok, count: Array.isArray(j?.results) ? j.results.length : 0 });
    }

    return res.status(200).json({ ok: true, results: out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
