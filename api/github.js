// /api/github.js
export const config = { runtime: 'nodejs' };

const GH_API = 'https://api.github.com';

function pickRepo(repoQuery, env) {
  // ?repo=symbols => อ่านจาก GH_REPO_SYMBOLS; นอกนั้นใช้ GH_REPO
  if (repoQuery === 'symbols') return env.GH_REPO_SYMBOLS || env.GH_REPO;
  return env.GH_REPO;
}

async function ghFetch(env, path, method = 'GET', body = undefined, repoQuery = '') {
  const repo   = pickRepo(repoQuery, env);
  const branch = env.GH_BRANCH || 'main';
  const token  = env.GH_TOKEN;

  if (!repo)  throw new Error('GH_REPO not set');
  if (!token) throw new Error('GH_TOKEN not set');

  const url = `${GH_API}/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const headers = {
    'Authorization': `token ${token}`,
    'User-Agent': 'signal-dashboard-ui',
    'Accept'     : 'application/vnd.github+json'
  };

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return res.json();
}

export async function ghRead(env, path, repoQuery = '') {
  const data = await ghFetch(env, path, 'GET', undefined, repoQuery);
  if (!data || !data.content) throw new Error('invalid GitHub response');
  return Buffer.from(data.content, 'base64').toString('utf8');
}

export async function ghWrite(env, path, content, message, sha = undefined, repoQuery = '') {
  const repo   = pickRepo(repoQuery, env);
  const branch = env.GH_BRANCH || 'main';
  const token  = env.GH_TOKEN;

  if (!repo)  throw new Error('GH_REPO not set');
  if (!token) throw new Error('GH_TOKEN not set');

  const url = `${GH_API}/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const headers = {
    'Authorization': `token ${token}`,
    'User-Agent'   : 'signal-dashboard-ui',
    'Accept'       : 'application/vnd.github+json',
    'Content-Type' : 'application/json'
  };

  const body = {
    message: message || `update ${path}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return res.json();
}

// helpers (ให้ไฟล์อื่น import แบบสะดวก)
export async function readJsonFromGitHub(path, repoQuery = '') {
  const text = await ghRead(process.env, path, repoQuery);
  return JSON.parse(text);
}
export async function writeJsonToGitHub(path, obj, message, repoQuery = '') {
  const content = JSON.stringify(obj, null, 2);
  return ghWrite(process.env, path, content, message, undefined, repoQuery);
}

// HTTP handler (สำหรับเทสด้วยลิงก์)
export default async function handler(req, res) {
  try {
    const { searchParams } = new URL(req.url, 'http://localhost');
    const op   = searchParams.get('op')   || 'ping';
    const path = searchParams.get('path') || '';
    const repo = searchParams.get('repo') || '';

    if (op === 'ping') {
      return res.status(200).json({ ok: true, repo: pickRepo(repo, process.env) });
    }

    if (op === 'read') {
      if (!path) return res.status(400).json({ ok: false, error: 'missing path' });
      const text = await ghRead(process.env, path, repo);
      try { return res.status(200).json(JSON.parse(text)); }
      catch { return res.status(200).send(text); }
    }

    if (op === 'write') {
      if (!path) return res.status(400).json({ ok: false, error: 'missing path' });
      const content = searchParams.get('content') || '';
      const message = searchParams.get('message') || '';
      const out = await ghWrite(process.env, path, content, message, undefined, repo);
      return res.status(200).json({ ok: true, out });
    }

    return res.status(400).json({ ok: false, error: `unknown op: ${op}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
