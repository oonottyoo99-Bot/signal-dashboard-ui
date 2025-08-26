// api/signals.js
//
// - ถ้ามี ?group=sp500 → อ่าน data/signals-sp500.json
// - ถ้าไม่ส่ง group → อ่าน data/signals.json (ผลล่าสุด)

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const group = (req.query.group || "").toString().trim();
    const path = group ? `data/signals-${group}.json` : "data/signals.json";

    const base =
      process.env.NEXT_PUBLIC_API_BASE ||
      `https://${req.headers.host ?? "localhost"}`;

    const r = await fetch(`${base}/api/github?op=read&path=${encodeURIComponent(path)}`, { cache: "no-store" });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).json({ error: `read failed: ${txt}` });
    }
    const json = await r.json();
    return res.status(200).json(json);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
