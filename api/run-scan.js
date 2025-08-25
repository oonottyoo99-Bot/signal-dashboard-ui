// api/run-scan.js
/**
 * Batch scanner:
 * - รับ ?group=...&manual=1&limit=25&offset=0
 * - อ่านรายชื่อจาก data/symbols.json (บน GitHub)
 * - สแกนทีละก้อน (slice) แล้วเขียน data/signals.json กลับ GitHub (merge ต่อเนื่อง)
 * - ตอบกลับ nextOffset เพื่อให้ฝั่ง UI เรียกต่อจนจบ
 *
 * ต้องมี ENV:
 *   GH_TOKEN              (Fine-grained/Classic token ที่อ่านเขียน repo นี้ได้)
 *   GH_REPO               (เช่น 'oonottyoo99-Bot/signal-dashboard-ui')
 *   GH_REPO_SYMBOLS       (ถ้าเก็บ symbols แยก repo; ถ้าไม่ตั้ง จะใช้ GH_REPO)
 *   GH_BRANCH             (ปกติ 'main')
 *   GH_PATH_SIGNALS       (เช่น 'data/signals.json')
 *   GH_PATH_SETTINGS      (เช่น 'data/settings.json' — ไม่ได้ใช้งานในไฟล์นี้แต่ให้คงไว้)
 */

const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = process.env.GH_REPO;
const GH_REPO_SYMBOLS = process.env.GH_REPO_SYMBOLS || GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || "main";
const GH_PATH_SIGNALS = process.env.GH_PATH_SIGNALS || "data/signals.json";

if (!GH_TOKEN || !GH_REPO || !GH_BRANCH) {
  console.warn("[run-scan] Missing required envs: GH_TOKEN/GH_REPO/GH_BRANCH");
}

const GITHUB_API = "https://api.github.com";

/** ---------- Minimal GitHub helper ---------- */
async function ghGetJson(repo, path) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodeURIComponent(
    path
  )}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const r = await fetch(url, {
    headers: { Authorization: `token ${GH_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`HTTP ${r.status} ${text}`);
  }
  const data = await r.json();
  const buf = Buffer.from(data.content || "", data.encoding || "base64");
  return { json: JSON.parse(buf.toString("utf8") || "{}"), sha: data.sha };
}

async function ghPutJson(repo, path, json, message, prevSha /* optional */) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const content = Buffer.from(JSON.stringify(json, null, 2), "utf8").toString("base64");
  const body = {
    message: message || `update ${path}`,
    content,
    branch: GH_BRANCH,
  };
  if (prevSha) body.sha = prevSha;

  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`HTTP ${r.status} ${text}`);
  }
  return r.json();
}

/** ---------- tiny fake scanner ---------- */
/** NOTE: ตรงนี้คือที่คุณจะเสียบ “อินดิเคเตอร์จริง” ได้ภายหลัง */
function scanTickers(tickers) {
  // ตัวอย่าง: สร้างสัญญาณ mock
  return tickers.map((t) => ({
    ticker: t,
    signal: "Sell", // TODO: ใส่ logic จริงได้ภายหลัง
    price: null,
    timeframe: "1D",
  }));
}

/** ---------- merge helper สำหรับ signals.json ---------- */
function mergeSignals(prev, incoming, group, updatedAt) {
  // โครงสร้างไฟล์ของเราคือ:
  // { group: string, updatedAt: ISO, results: Array<{ticker,...}> }
  let base = prev && prev.group === group ? prev : { group, updatedAt, results: [] };

  // ถ้าเป็นรอบใหม่ (offset=0) ให้รีเซ็ตผลเก่า
  if (prev && prev.group === group) {
    // keep results; ถ้าคนเรียก offset=0 เราจะทับให้ใหม่ข้างล่าง
  }

  // กำจัดซ้ำด้วย set จาก ticker
  const seen = new Set(base.results.map((r) => r.ticker));
  const merged = [...base.results];

  for (const item of incoming) {
    if (!seen.has(item.ticker)) {
      merged.push(item);
      seen.add(item.ticker);
    } else {
      // ถ้าอยากอัปเดตทับข้อมูล ticker เดิม ให้แทนที่
      const idx = merged.findIndex((r) => r.ticker === item.ticker);
      if (idx >= 0) merged[idx] = item;
    }
  }

  return { group, updatedAt, results: merged };
}

/** ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    const { group, manual, limit: qLimit, offset: qOffset } = req.query || {};
    if (!group) return res.status(400).json({ error: "missing group" });

    // batch params
    const limit = Math.max(1, Math.min(100, parseInt(qLimit || "25", 10) || 25));
    const offset = Math.max(0, parseInt(qOffset || "0", 10) || 0);

    // อ่านรายชื่อสัญลักษณ์
    const { json: symbolsJson } = await ghGetJson(GH_REPO_SYMBOLS, "data/symbols.json");
    if (!symbolsJson[group] || !Array.isArray(symbolsJson[group]) || symbolsJson[group].length === 0) {
      return res.status(400).json({ error: `กลุ่ม ${group} ไม่มีรายการใน data/symbols.json` });
    }

    const all = symbolsJson[group];
    const slice = all.slice(offset, offset + limit);
    const updatedAt = new Date().toISOString();

    // สแกน (ตัวอย่าง: mock)
    const results = scanTickers(slice);

    // อ่าน signals.json เดิม
    let prevJson = null;
    let prevSha = undefined;
    try {
      const r = await ghGetJson(GH_REPO, GH_PATH_SIGNALS);
      prevJson = r.json;
      prevSha = r.sha;
    } catch (e) {
      // ถ้ายังไม่มีไฟล์ ให้สร้างใหม่
      prevJson = { group: "-", updatedAt: null, results: [] };
      prevSha = undefined;
    }

    // ถ้าเป็น batch แรก (offset==0) ให้รีเซ็ตผลเก่าของ group เดิม
    if (offset === 0) {
      prevJson = { group, updatedAt, results: [] };
    }

    // merge + เขียนกลับ
    const merged = mergeSignals(prevJson, results, group, updatedAt);
    await ghPutJson(GH_REPO, GH_PATH_SIGNALS, merged, `update ${GH_PATH_SIGNALS} ${group} (${offset}-${offset + slice.length})`, prevSha);

    // คำนวณ next
    const nextOffset = offset + slice.length < all.length ? offset + slice.length : null;

    return res.status(200).json({
      ok: true,
      group,
      total: all.length,
      batch: slice.length,
      limit,
      offset,
      nextOffset,
      updatedAt,
    });
  } catch (err) {
    console.error("[run-scan] error", err);
    return res.status(500).json({ error: "scan failed", detail: String(err && err.message ? err.message : err) });
  }
}
