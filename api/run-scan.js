// /api/run-scan.js
const {
  GH_TOKEN,
  GH_REPO,
  GH_BRANCH = 'main',
  GH_PATH_SIGNALS = 'signals.json',
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
  const body = { message: message || `update ${path}`, content: contentB64, branch: GH_BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${path} → ${r.status}`);
  return true;
}

// in-memory fallback
globalThis.__MEM__ = globalThis.__MEM__ || {
  signals: {
    last_updated: new Date().toISOString(),
    scan_group: '-',
    signals_found: [],
  },
};

function mockScan(group) {
  const pool = ['AAPL','MSFT','NVDA','GOOGL','AMZN','TSLA','META'];
  const pick = () => pool[Math.floor(Math.random()*pool.length)];
  const rows = Array.from({length: 5}, () => ({
    ticker: pick(),
    signal: Math.random() > 0.5 ? 'Strong Buy' : 'Buy',
    price: +(100 + Math.random()*400).toFixed(2),
    timeframe: Math.random() > 0.5 ? 'H1' : 'H4',
  }));
  return {
    last_updated: new Date().toISOString(),
    scan_group: group,
    signals_found: rows,
  };
}

export default async function handler(req, res) {
  try {
    const group = String(req.query.group || '').toLowerCase();
    if (!group) return res.status(400).json({ ok:false, error:'missing group' });

    // จำลองการสแกน
    const result = mockScan(group);

    // เขียนผลลง GitHub หรือ in-memory
    if (GH_TOKEN && GH_REPO) {
      const file = await ghGetFile(GH_PATH_SIGNALS);
      await ghPutFile(GH_PATH_SIGNALS, result, file?.sha, `scan: ${group}`);
    } else {
      globalThis.__MEM__.signals = result;
    }

    return res.status(200).json({ ok: true, saved: true, group, count: result.signals_found.length });
  } catch (e) {
    console.error('run-scan error', e);
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}
