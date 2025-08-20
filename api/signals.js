// api/signals.js
import { readJsonFile, writeJsonFile, PATHS, withCors } from "./_github";

const defaultSignals = {
  last_updated: "-",
  scan_group: "-",
  signals_found: [],
};

export default async function handler(req, res) {
  withCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method === "GET") {
      const data = await readJsonFile(PATHS.GH_PATH_SIGNALS, defaultSignals);
      return res.status(200).json(data);
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const payload = body && typeof body === "object" ? body : defaultSignals;
      await writeJsonFile(PATHS.GH_PATH_SIGNALS, payload, "update signals.json");
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
