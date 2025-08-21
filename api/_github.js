// api/_github.js
const REPO_MAIN   = process.env.GH_REPO;                 // repo หลัก (signals/settings)
const REPO_SYMBOL = process.env.GH_REPO_SYMBOLS || REPO_MAIN; // repo ของ symbols.json (ถ้าไม่ตั้ง จะใช้ REPO_MAIN)
const BRANCH      = process.env.GH_BRANCH || 'main';
const TOKEN       = process.env.GH_TOKEN;

function pickRepo(path) {
  // ถ้าอ่าน/เขียนที่โฟลเดอร์ data/ ให้ไปที่ REPO_SYMBOL
  if ((path || '').startsWith('data/')) return REPO_SYMBOL;
  return REPO_MAIN;
}

async function ghRequest(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `token ${TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>'');
    throw new Error(`HTTP ${res.status} ${t}`);
  }
  return res.json();
}

// อ่านไฟล์ (raw text)
export async function ghRead(path) {
  const repo = pickRepo(path);
  const url  = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(BRANCH)}`;
  const j = await ghRequest('GET', url);
  const b64 = j.content?.replace(/\n/g, '') || '';
  return Buffer.from(b64, 'base64').toString('utf8');
}

// เขียนไฟล์ (upsert)
export async function ghWrite(path, content, message = `update ${path}`) {
  const repo = pickRepo(path);
  const getUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(BRANCH)}`;
  let sha = undefined;
  try {
    const j = await ghRequest('GET', getUrl);
    sha = j.sha;
  } catch (_) { /* not found -> create */ }

  const putUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: BRANCH,
    sha,
  };
  return ghRequest('PUT', putUrl, body);
}

// HTTP handler (debug/manual)
export default async function handler(req, res) {
  try {
    const { op, path, content } = req.query;
    if (op === 'read') {
      const text = await ghRead(path);
      res.status(200).send(text);
      return;
    }
    if (op === 'write') {
      await ghWrite(path, content || '');
      res.status(200).json({ ok: true });
      return;
    }
    res.status(400).json({ error: 'unknown op' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
