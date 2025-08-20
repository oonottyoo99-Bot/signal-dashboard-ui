// api/settings.js
import { readJsonFile, writeJsonFile, PATHS, withCors } from "./_github";

const defaultSettings = { auto_scan_groups: [] };

export default async function handler(req, res) {
  withCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method === "GET") {
      const data = await readJsonFile(PATHS.GH_PATH_SETTINGS, defaultSettings);
      return res.status(200).json(data);
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const arr = Array.isArray(body?.auto_scan_groups) ? body.auto_scan_groups : [];
      const payload = { auto_scan_groups: arr };
      await writeJsonFile(PATHS.GH_PATH_SETTINGS, payload, "update settings.json");
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
