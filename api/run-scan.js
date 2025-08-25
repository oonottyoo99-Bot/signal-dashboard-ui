// api/run-scan.js
// Batch scan + เขียนผลไปที่ data/signals.json ใน repo หลัก โดยเรียก GitHub API ตรง ๆ
// ไม่พึ่งพาไฟล์ helper ใด ๆ
//
// ENV ที่ต้องมี (คุณตั้งไว้แล้ว):
//   GH_REPO                = owner/repo   (repo หลักที่เก็บ signals.json)
//   GH_REPO_SYMBOLS       = owner/repo   (repo ที่เก็บ symbols.json; ถ้าไม่ใส่จะ fallback ไป GH_REPO)
//   GH_BRANCH             = main
//   GH_TOKEN              = <token PAT>
//   GH_PATH_SIGNALS       = data/signals.json
//   (PATH_SYMBOLS คงที่: data/symbols.json)
// ------------------------------------------------------------

const fetch = global.fetch;

const REPO_MAIN   = process.env.GH_REPO;
const REPO_SYMBOL = process.env.GH_REPO_SYMBOLS || process.env.GH_REPO;
const BRANCH      = process.env.GH_BRANCH || "main";
const TOKEN       = process.env.GH_TOKEN || "";
const PATH_SIGNALS = process.env.GH_PATH_SIGNALS || "data/signals.json";
const PATH_SYMBOLS = "data/symbols.json";

function bad(res, code, msg) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: false, error: msg }));
}

function ok(res, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

// ---------- GitHub REST helpers (Contents API) ----------
const GH_API = "https://api.github.com";

async function ghGetContents(repo, path) {
  const url = `${GH_API}/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(BRANCH)}`;
  const r = await fetch(url, {
    headers: {
      "Authorization": TOKEN ? `token ${TOKEN}` : undefined,
      "Accept": "application/vnd.github+json",
      "User-Agent": "signal-dashboard-ui",
    },
  });
  if (r.status === 404) return { ok: false, status: 404 };
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    return { ok: false, status: r.status, detail: t };
  }
  const j = await r.json();
  // j.content เป็น base64
  const content = Buffer.from(j.content || "", "base64").toString("utf8");
  return { ok: true, sha: j.sha, content };
}

async function ghPutContents(repo, path, jsonObj, sha) {
  const url = `${GH_API}/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const contentB64 = Buffer.from(JSON.stringify(jsonObj, null, 2), "utf8").toString("base64");
  const body = {
    message: `update ${path}`,
    content: contentB64,
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": TOKEN ? `token ${TOKEN}` : undefined,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "signal-dashboard-ui",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    return { ok: false, status: r.status, detail: t };
  }
  return { ok: true };
}

// อ่าน symbols.json แบบ raw (เร็วกว่า) — ถ้าไม่เจอ ค่อย fallback ไป Contents API
async function readSymbolsArray(group) {
  // raw URL
  const raw = `https://raw.githubusercontent.com/${REPO_SYMBOL}/${BRANCH}/${PATH_SYMBOLS}?t=${Date.now()}`;
  let txt = null;
  try {
    const r = await fetch(raw, { headers: { "User-Agent": "signal-dashboard-ui" } });
    if (r.ok) txt = await r.text();
  } catch (_) {}
  if (!txt) {
    // fallback: contents
    const got = await ghGetContents(REPO_SYMBOL, PATH_SYMBOLS);
    if (!got.ok) throw new Error(`read symbols failed: ${got.status} ${got.detail || ""}`);
    txt = got.content;
  }
  const json = JSON.parse(txt);
  if (!json[group]) throw new Error(`ไม่พบกลุ่ม ${group} ใน ${PATH_SYMBOLS}`);
  return json[group]; // array of tickers
}

// merge batch results with old
function mergeResults(oldArr = [], addArr = []) {
  const map = new Map();
  for (const x of oldArr) map.set(x.ticker, x);
  for (const x of addArr) map.set(x.ticker, x);
  return Array.from(map.values());
}

// mock scanner: ใส่ logic จริงของคุณภายหลังได้
async function scanOne(ticker) {
  return { ticker, signal: "Sell", price: null, timeframe: "1D" };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") return bad(res, 405, "Method not allowed");

    const url = new URL(req.url, `http://${req.headers.host}`);
    const group  = (url.searchParams.get("group") || "").trim();
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const limit  = Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10));

    if (!group) return bad(res, 400, "missing ?group");

    // 1) symbols
    const all = await readSymbolsArray(group);
    const total = all.length;

    const start = Math.min(Math.max(0, offset), total);
    const end   = Math.min(start + limit, total);
    const batchTickers = all.slice(start, end);

    // 2) สแกนเฉพาะ batch นี้
    const batchResults = [];
    for (const tk of batchTickers) batchResults.push(await scanOne(tk));

    // 3) โหลด signals.json เดิม + sha เพื่อ merge/อัปเดต
    let oldPayload = null;
    let sha = null;
    {
      const got = await ghGetContents(REPO_MAIN, PATH_SIGNALS);
      if (got.ok) { sha = got.sha; try { oldPayload = JSON.parse(got.content || "{}"); } catch(_) {} }
      else if (got.status !== 404) throw new Error(`read signals failed: ${got.status} ${got.detail || ""}`);
    }

    const updatedAt = new Date().toISOString();
    const baseResults = (oldPayload && oldPayload.group === group && Array.isArray(oldPayload.results))
      ? oldPayload.results : [];

    const merged = mergeResults(baseResults, batchResults);
    const done   = end;
    const nextOffset = end < total ? end : null;

    const newPayload = {
      group,
      updatedAt,
      results: merged,
      total,
      done,
      batch: batchResults.length,
      nextOffset,
    };

    // 4) เขียนกลับ (มี sha ใส่ไปด้วย, ถ้าไม่มี sha = create)
    const put = await ghPutContents(REPO_MAIN, PATH_SIGNALS, newPayload, sha);
    if (!put.ok) return bad(res, 422, `write failed: ${put.status} ${put.detail || ""}`);

    return ok(res, { ok: true, ...newPayload });
  } catch (e) {
    return bad(res, 500, `scan failed: ${String(e)}`);
  }
};
