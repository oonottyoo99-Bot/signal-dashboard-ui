// api/_github.js
// ------------------------------------------------------
// GitHub content helper (อ่าน/เขียนไฟล์ใน repo)
// - REPO_MAIN:   ใช้กับ signals.json / settings.json
// - REPO_SYMBOL: ใช้กับ data/symbols.json (ถ้าไม่ตั้ง จะ fallback ไป REPO_MAIN)
// ------------------------------------------------------

const REPO_MAIN   = process.env.GH_REPO;                   // ex: oonottyoo99-Bot/Alert
const REPO_SYMBOL = process.env.GH_REPO_SYMBOLS || REPO_MAIN; // ex: oonottyoo99-Bot/signal-dashboard-ui
const BRANCH      = process.env.GH_BRANCH || "main";
const TOKEN       = process.env.GH_TOKEN;

function pickRepo(path = "") {
  // ถ้า path อยู่ใต้โฟลเดอร์ data/ ให้ใช้ REPO_SYMBOL
  if (path.startsWith("data/")) return REPO_SYMBOL;
  return REPO_MAIN;
}

async function ghRequest(method, url, bodyObj) {
  const headers = {
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json"
  };
  if (TOKEN) headers.Authorization = `token ${TOKEN}`;

  const res = await fetch(url, {
    method,
    headers,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
    cache: "no-store",
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${txt}`);
  }
  return res.json();
}

// อ่านไฟล์ (คืนค่าเป็น string)
export async function ghRead(path) {
  const repo = pickRepo(path);
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(BRANCH)}`;
  const j = await ghRequest("GET", url);
  const base64 = (j.content || "").replace(/\n/g, "");
  return Buffer.from(base64, "base64").toString("utf8");
}

// เขียนไฟล์ (อัปเดตถ้ามี, สร้างถ้ายังไม่มี)
export async function ghWrite(path, content, message = `update ${path}`) {
  const repo = pickRepo(path);
  const getUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(BRANCH)}`;

  let sha;
  try {
    const meta = await ghRequest("GET", getUrl);
    sha = meta.sha;
  } catch {
    // 404 -> create new
  }

  const putUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: BRANCH,
    sha,
  };
  return ghRequest("PUT", putUrl, body);
}

// HTTP handler (debug/manual test): /api/_github?op=read&path=...  หรือ  op=write&path=...&content=...
export default async function handler(req, res) {
  try {
    const { op, path, content } = req.query;

    if (op === "read") {
      if (!path) return res.status(400).json({ ok: false, error: "missing path" });
      const text = await ghRead(path);
      // ส่งเป็น text ตรง ๆ (สะดวกเปิดดู contents)
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.status(200).send(text);
      return;
    }

    if (op === "write") {
      if (!path) return res.status(400).json({ ok: false, error: "missing path" });
      await ghWrite(path, content || "", `update via api/_github`);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: "unknown op" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
