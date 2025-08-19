// /api/signals.js
const {
  GH_TOKEN,
  GH_REPO,
  GH_BRANCH = 'main',
  GH_PATH_SIGNALS = 'signals.json',
  GH_PATH_SETTINGS = 'settings.json',
} = process.env;

function parseRepo(repo) {
  const [owner, name] = (repo || '').split('/');
  return { owner, name };
}

async function ghGetFile(path) {
  if (!GH_TOKEN || !GH_REPO) return null;
  const { owner, name } = parseRepo(GH_REPO);
  const url = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const r = await fetch(url, {
    headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GET ${path} → ${r.status}`);
  const j = await r.json();
  const content = Buffer.from(j.content || '', 'base64').toString('utf8');
  return { json: JSON.parse(content), sha: j.sha };
}

async function ghPutFile(path, json, sha, message) {
  if (!GH_TOKEN || !GH_REPO) return false;
  const { owner, name } = parseRepo(GH_REPO);
  const url = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`;
  const contentB64 = Buffer.from(JSON.stringify(json, null, 2), 'utf8').toString('base64');
  const body = {
    message: message || `update ${path}`,
    content: contentB64,
    branch: GH_BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${path} → ${r.status}`);
  return true;
}

// fallback in-memory (กรณีไม่มี GH_TOKEN)
globalThis.__MEM__ = globalThis.__MEM__ || {
  signals: {
    last_updated: new Date().toISOString(),
    scan_group: '-',
    signals_found: [],
  },
};

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // อ่านไฟล์ signals.json จาก GitHub (หรือ in-memory)
      const file = await ghGetFile(GH_PATH_SIGNALS);
      const data = file?.json || globalThis.__MEM__.signals;
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      // เขียนไฟล์ signals.json (รับ payload มาจากรันสแกน)
      const payload = req.body || {};
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ ok: false, error: 'invalid payload' });
      }
      // อ่าน sha เดิมก่อน
      const file = await ghGetFile(GH_PATH_SIGNALS);
      const sha = file?.sha;
      // อัปเดตเวลาเผื่อ user ไม่ส่งมา
      payload.last_updated = payload.last_updated || new Date().toISOString();

      if (GH_TOKEN && GH_REPO) {
        await ghPutFile(GH_PATH_SIGNALS, payload, sha, `update ${GH_PATH_SIGNALS}`);
      } else {
        globalThis.__MEM__.signals = payload;
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader('allow', 'GET,POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('signals error', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
