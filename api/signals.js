// api/signals.js
export default async function handler(_req, res) {
  try {
    const data = await readJsonFromGitHub(
      process.env.GH_REPO,
      process.env.GH_BRANCH || "main",
      process.env.GH_PATH_SIGNALS || "data/signals.json",
      process.env.GH_TOKEN
    );

    // กันค่าเริ่มต้นให้ UI เสมอ
    const safe = ensureSignalsShape(data);
    return res.status(200).json(safe);
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Cannot read signals", detail: String(err) });
  }
}

/* -------------------- Helpers -------------------- */

function ensureSignalsShape(x) {
  const group = typeof x?.group === "string" ? x.group : "-";
  const updatedAt = x?.updatedAt ?? null;
  const results = Array.isArray(x?.results) ? x.results : [];
  return { group, updatedAt, results };
}

async function readJsonFromGitHub(repo, branch, path, token) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(
    path
  )}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: token ? `token ${token}` : undefined,
    },
  });

  if (r.status === 404) {
    // ถ้ายังไม่มีไฟล์ ให้ส่ง default
    return { group: "-", updatedAt: null, results: [] };
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);

  const json = await r.json();
  const content = Buffer.from(json.content || "", "base64").toString("utf8");
  if (!content.trim()) return { group: "-", updatedAt: null, results: [] };

  try {
    return JSON.parse(content);
  } catch {
    return { group: "-", updatedAt: null, results: [] };
  }
}
