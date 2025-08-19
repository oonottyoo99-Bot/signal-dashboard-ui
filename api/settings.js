// api/settings.js
// GET  : อ่าน settings.json (auto_scan_groups)
// POST : { auto_scan_groups: string[] } → บันทึกลง GitHub หรือหน่วยความจำ

export default async function handler(req, res) {
  // CORS + preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    if (req.method === 'GET') {
      const data = (await readJsonFromGitHubOrMemory('settings')) || { auto_scan_groups: [] };
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const groups = Array.isArray(body?.auto_scan_groups) ? body.auto_scan_groups : [];
      const payload = { auto_scan_groups: groups };
      await writeJsonToGitHubOrMemory('settings', payload);
      return res.status(200).json({ ok: true, saved: true });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'settings_failed' });
  }
}

/* ----------------- helpers shared (inline) ----------------- */
const mem = { signals: null, settings: null };

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function readJsonFromGitHubOrMemory(kind) {
  const useGitHub = !!process.env.GH_TOKEN;
  const path =
    kind === 'signals'
      ? process.env.GH_PATH_SIGNALS || 'signals.json'
      : process.env.GH_PATH_SETTINGS || 'settings.json';

  if (!useGitHub) return mem[kind];

  const [owner, repo] = (process.env.GH_REPO || '').split('/');
  const branch = process.env.GH_BRANCH || 'main';
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
    path
  )}?ref=${encodeURIComponent(branch)}`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('github_read_failed');
  const j = await r.json();
  const buf = Buffer.from(j.content, 'base64').toString('utf8');
  return JSON.parse(buf);
}

async function writeJsonToGitHubOrMemory(kind, obj) {
  const useGitHub = !!process.env.GH_TOKEN;
  const path =
    kind === 'signals'
      ? process.env.GH_PATH_SIGNALS || 'signals.json'
      : process.env.GH_PATH_SETTINGS || 'settings.json';

  if (!useGitHub) {
    mem[kind] = obj;
    return;
  }

  const [owner, repo] = (process.env.GH_REPO || '').split('/');
  const branch = process.env.GH_BRANCH || 'main';
  const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
    path
  )}?ref=${encodeURIComponent(branch)}`;

  // หา sha เดิม (หากมี)
  let sha = undefined;
  const getResp = await fetch(getUrl, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (getResp.ok) {
    const j = await getResp.json();
    sha = j.sha;
  }

  const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message: `[vercel] update ${path}`,
    content: Buffer.from(JSON.stringify(obj, null, 2)).toString('base64'),
    branch,
    sha,
  };
  const putResp = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!putResp.ok) throw new Error('github_write_failed');
}
