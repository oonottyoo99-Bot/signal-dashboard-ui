// /api/settings.js
export default async function handler(req, res) {
  if (req.method === "GET") {
    return getSettings(req, res);
  }
  if (req.method === "POST") {
    return saveSettings(req, res);
  }
  return res.status(405).json({ error: "Method not allowed" });
}

async function getSettings(_req, res) {
  try {
    const repo = process.env.GH_REPO;
    const branch = process.env.GH_BRANCH || "main";
    const path = process.env.GH_PATH_SETTINGS || "settings.json";
    const token = process.env.GH_TOKEN;

    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${encodeURIComponent(path)}?t=${Date.now()}`;
    const r = await fetch(url, token ? { headers: { Authorization: `token ${token}` } } : {});
    if (!r.ok) {
      return res.status(200).json({ auto_scan_groups: [] });
    }
    const json = await r.json();
    return res.status(200).json(json);
  } catch (err) {
    console.error("GET /api/settings error:", err);
    return res.status(500).json({ error: "Cannot read settings", detail: String(err) });
  }
}

async function saveSettings(req, res) {
  try {
    const body = await readBody(req);
    const { auto_scan_groups } = body || {};
    if (!Array.isArray(auto_scan_groups)) {
      return res.status(400).json({ error: "payload must be { auto_scan_groups: string[] }" });
    }
    await writeToGitHub(
      process.env.GH_REPO,
      process.env.GH_BRANCH || "main",
      process.env.GH_PATH_SETTINGS || "settings.json",
      JSON.stringify({ auto_scan_groups }, null, 2),
      process.env.GH_TOKEN,
      "save settings.json"
    );
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("POST /api/settings error:", err);
    return res.status(500).json({ error: "Cannot save settings", detail: String(err) });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function writeToGitHub(repo, branch, filePath, content, token, message) {
  if (!repo || !token) throw new Error("Missing GH_REPO or GH_TOKEN");

  const apiUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}`;
  // หา sha เดิม (ถ้ามี)
  let sha = undefined;
  const head = await fetch(`${apiUrl}?ref=${branch}`, {
    headers: { Authorization: `token ${token}` },
  });
  if (head.ok) {
    const j = await head.json();
    sha = j.sha;
  }
  // เขียนไฟล์
  const put = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      message: message || "update via /api/settings",
      content: Buffer.from(content).toString("base64"),
      branch,
      sha,
    }),
  });
  if (!put.ok) {
    const txt = await put.text();
    throw new Error(`GitHub write failed: ${put.status} ${txt}`);
  }
}
