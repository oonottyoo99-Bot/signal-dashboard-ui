// /api/_github.js
export default async function handler(req, res) {
  try {
    const {
      GH_TOKEN = process.env.GH_TOKEN,
      GH_REPO  = process.env.GH_REPO,   // รูปแบบ: owner/repo
      GH_BRANCH = process.env.GH_BRANCH || "main",
    } = process.env;

    if (!GH_TOKEN || !GH_REPO) {
      return res.status(400).json({ error: "Missing GH_TOKEN or GH_REPO" });
    }

    const op   = (req.query.op || req.body?.op || "read").toLowerCase();
    const path = req.query.path || req.body?.path;
    if (!path) return res.status(400).json({ error: "Missing ?path=…" });

    const api = "https://api.github.com";

    async function ghFetch(url, opts = {}) {
      const r = await fetch(url, {
        ...opts,
        headers: {
          "Authorization": `Bearer ${GH_TOKEN}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
          ...opts.headers,
        },
        next: { revalidate: 0 },
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status} ${url} :: ${text}`);
      }
      return r.json();
    }

    async function readFile(p) {
      const u = `${api}/repos/${GH_REPO}/contents/${encodeURIComponent(p)}?ref=${encodeURIComponent(GH_BRANCH)}`;
      const j = await ghFetch(u);
      const buff = Buffer.from(j.content, "base64").toString("utf8");
      return { content: buff, sha: j.sha };
    }

    async function writeFile(p, content) {
      // ดูว่าไฟล์มีอยู่ไหม เพื่อเอา sha
      let sha = undefined;
      try {
        const cur = await readFile(p);
        sha = cur.sha;
      } catch (e) {
        // ไม่มีไฟล์ (201 จะถูกใช้ตอนสร้างใหม่)
      }
      const u = `${api}/repos/${GH_REPO}/contents/${encodeURIComponent(p)}`;
      const body = {
        message: `update ${p} by signal-dashboard-ui`,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: GH_BRANCH,
        ...(sha ? { sha } : {}),
      };
      const j = await ghFetch(u, { method: "PUT", body: JSON.stringify(body) });
      return j;
    }

    if (op === "read") {
      const { content } = await readFile(path);
      return res.status(200).send(content); // ส่ง raw
    } else if (op === "write") {
      const raw = typeof req.body?.content === "string"
        ? req.body.content
        : JSON.stringify(req.body?.content ?? {}, null, 2);
      const j = await writeFile(path, raw);
      return res.status(200).json({ ok: true, path, commit: j.commit?.sha });
    } else {
      return res.status(400).json({ error: `Unsupported op: ${op}` });
    }
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
