// /api/signals.js
export default async function handler(req, res) {
  try {
    const repo = process.env.GH_REPO;
    const branch = process.env.GH_BRANCH || "main";
    const path = process.env.GH_PATH_SIGNALS || "signals.json";
    const token = process.env.GH_TOKEN;

    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${encodeURIComponent(path)}?t=${Date.now()}`;
    const r = await fetch(url, token ? { headers: { Authorization: `token ${token}` } } : {});
    if (!r.ok) {
      // ยังไม่มีไฟล์ -> ส่งโครงเริ่มต้นกลับไป
      return res.status(200).json({
        group: "-",
        updatedAt: null,
        results: [],
      });
    }
    const json = await r.json();
    return res.status(200).json(json);
  } catch (err) {
    console.error("GET /api/signals error:", err);
    return res.status(500).json({ error: "Cannot read signals", detail: String(err) });
  }
}
