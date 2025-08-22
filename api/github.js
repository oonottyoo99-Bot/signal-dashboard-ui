// /api/github.js
export const config = { runtime: 'nodejs' };

const GH_API = 'https://api.github.com';

function pickRepo(repoQuery, env) {
  return repoQuery === 'symbols' ? (env.GH_REPO_SYMBOLS || env.GH_REPO) : env.GH_REPO;
}

function headers(token) {
  return {
    'Authorization': `token ${token}`,
    'User-Agent': 'signal-dashboard-ui',
    'Accept': 'application/vnd.github+json'
  };
}

async function getContentMeta(env, path, repoQuery = '') {
  const repo   = pickRepo(repoQuery, env);
  const branch = env.GH_BRANCH || 'main';
  const token  = env.GH_TOKEN;
  const url = `${GH_API}/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: headers(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  return res.json(); // { content, sha, ... }
}

export async function ghRead(env, path, repoQuery = '') {
  const meta = await getContentMeta(env, path, repoQuery);
  if (!meta || !meta.content) throw new Error('Not Found');
  return Buffer.from(meta.content, 'base64').toString('utf8');
}

export async function ghWrite(env, path, content, message, repoQuery = '') {
  const repo   = pickRepo(repoQuery, env);
  const branch = env.GH_BRANCH || 'main';
  const token  = env.GH_TOKEN;

  if (!repo)  throw new Error('GH_REPO not set');
  if (!token) throw new Error('GH_TOKEN not set');

  // ถ้ามีไฟล์อยู่แล้ว ดึง sha มาก่อน
  let sha;
  const meta = await getContentMeta(env, path, repoQuery);
  if (meta && meta.sha) sha = meta.sha;

  const url = `${GH_API}/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message: message || `update ${path}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

export async function readJsonFromGitHub(path, repoQuery = '') {
  const text = await ghRead(process.env, path, repoQuery);
  return JSON.parse(text);
}

export async function writeJsonToGitHub(path, obj, message, repoQuery = '') {
  const content = JSON.stringify(obj, null, 2);
  return ghWrite(process.env, path, content, message, repoQuery);
}

export default async function handler(req, res) {
  try {
    const { searchParams } = new URL(req.url, 'http://localhost');
    const op   = searchParams.get('op')   || 'ping';
    const path = searchParams.get('path') || '';
    const repo = searchParams.get('repo') || ''; // '' หรือ 'symbols'

    if (op === 'ping') {
      return res.status(200).json({ ok: true, repo: pickRepo(repo, process.env) });
    }

    if (op === 'read') {
      if (!path) return res.status(400).json({ ok: false, error: 'missing path' });
      try {
        const text = await ghRead(process.env, path, repo);
        try { return res.status(200).json(JSON.parse(text)); }
        catch { return res.status(200).send(text); }
      } catch (e) {
        return res.status(200).json({ ok: false, error: String(e.message || e) });
      }
    }

    if (op === 'write') {
      if (!path) return res.status(400).json({ ok: false, error: 'missing path' });
      const content = searchParams.get('content') ?? '';
      const message = searchParams.get('message') ?? `update ${path}`;
      const out = await ghWrite(process.env, path, content, message, repo);
      return res.status(200).json({ ok: true, out });
    }

    // สร้างไฟล์ค่าเริ่มต้นถ้าไม่พบ
    if (op === 'ensure') {
      if (!path) return res.status(400).json({ ok: false, error: 'missing path' });
      const meta = await getContentMeta(process.env, path, repo);
      if (meta && meta.sha) return res.status(200).json({ ok: true, created: false });
      const defaultJson = JSON.stringify({ auto_scan_groups: [] }, null, 2);
      await ghWrite(process.env, path, defaultJson, `init ${path}`, repo);
      return res.status(200).json({ ok: true, created: true });
    }

    return res.status(400).json({ ok: false, error: `unknown op: ${op}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
