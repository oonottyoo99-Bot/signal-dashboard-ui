// api/settings.js
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const data = await readJsonFromGitHub(
        process.env.GH_REPO,
        process.env.GH_BRANCH || "main",
        process.env.GH_PATH_SETTINGS || "data/settings.json",
        process.env.GH_TOKEN
      );
      // กันเคสไฟล์ว่าง/ไม่มี -> ส่งค่าเริ่มต้นที่ UI ใช้ได้แน่
      return res.status(200).json(
        data && typeof data === "object"
          ? data
          : { auto_scan_groups: [] }
      );
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const next = normalizeSettings(body);

      // เขียนกลับ GitHub (ต้องแนบ sha ให้ถูก)
      await writeJsonToGitHub(
        process.env.GH_REPO,
        process.env.GH_BRANCH || "main",
        process.env.GH_PATH_SETTINGS || "data/settings.json",
        next,
        process.env.GH_TOKEN,
        "chore(settings): update auto_scan_groups via API"
      );

      return res.status(200).json(next);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Cannot read settings", detail: String(err) });
  }
}

/* -------------------- Helpers -------------------- */

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizeSettings(x) {
  const groups = Array.isArray(x?.auto_scan_groups) ? x.auto_scan_groups : [];
  const cleaned = [...new Set(groups.map(String).map((s) => s.trim()).filter(Boolean))];
  return { auto_scan_groups: cleaned };
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

  if (r.status === 404) return { auto_scan_groups: [] }; // ไฟล์ยังไม่เคยสร้าง
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);

  const json = await r.json();
  const content = Buffer.from(json.content || "", "base64").toString("utf8");
  if (!content.trim()) return { auto_scan_groups: [] };

  try {
    return JSON.parse(content);
  } catch (e) {
    // กัน parse พัง
    return { auto_scan_groups: [] };
  }
}

async function writeJsonToGitHub(repo, branch, path, obj, token, message) {
  // ต้อง get sha ก่อนทุกครั้ง เพื่อเลี่ยง 422 "sha wasn't supplied"
  const getUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(
    path
  )}?ref=${encodeURIComponent(branch)}`;

  const getResp = await fetch(getUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: token ? `token ${token}` : undefined,
    },
  });

  let sha;
  if (getResp.ok) {
    const meta = await getResp.json();
    sha = meta?.sha;
  } else if (getResp.status !== 404) {
    throw new Error(`HTTP ${getResp.status} ${await getResp.text()}`);
  }

  const putUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(
    path
  )}`;
  const content = Buffer.from(JSON.stringify(obj, null, 2), "utf8").toString("base64");

  const putResp = await fetch(putUrl, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: token ? `token ${token}` : undefined,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: message || "update via API",
      content,
      branch,
      sha, // ถ้ามี
    }),
  });

  if (!putResp.ok) {
    throw new Error(`HTTP ${putResp.status} ${await putResp.text()}`);
  }
}
