// api/_github.js
const memoryStore = {};

// ---- ENV
const GH_TOKEN   = process.env.GH_TOKEN || "";
const GH_REPO    = process.env.GH_REPO  || "";      // e.g. "oONOTTYOo99-Bot/oONOTTYOo99-Alert"
const GH_BRANCH  = process.env.GH_BRANCH|| "main";
const API_BASE   = "https://api.github.com";

// default paths
const GH_PATH_SIGNALS  = process.env.GH_PATH_SIGNALS  || "signals.json";
const GH_PATH_SETTINGS = process.env.GH_PATH_SETTINGS || "settings.json";

function useGithub() {
  return Boolean(GH_TOKEN && GH_REPO);
}

async function _ghGet(path) {
  const url = `${API_BASE}/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${GH_TOKEN}`,
      "Accept": "application/vnd.github+json"
    },
    cache: "no-store",
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GET failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function _ghPut(path, contentBase64, sha, message="update via vercel api") {
  const url = `${API_BASE}/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: contentBase64,
    branch: GH_BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${GH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub PUT failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function readJsonFile(path, fallback) {
  if (useGithub()) {
    const meta = await _ghGet(path);
    if (!meta) return fallback;
    const buf = Buffer.from(meta.content, meta.encoding || "base64");
    try { return JSON.parse(buf.toString("utf-8")); }
    catch { return fallback; }
  }
  // in-memory fallback
  return memoryStore[path] ?? fallback;
}

export async function writeJsonFile(path, data, message="update via vercel api") {
  if (useGithub()) {
    // read sha if exists
    const meta = await _ghGet(path);
    const sha = meta?.sha;
    const contentBase64 = Buffer.from(JSON.stringify(data, null, 2), "utf-8").toString("base64");
    await _ghPut(path, contentBase64, sha, message);
    return true;
  }
  // in-memory fallback
  memoryStore[path] = data;
  return true;
}

// expose default paths
export const PATHS = { GH_PATH_SIGNALS, GH_PATH_SETTINGS };

// CORS helper (ถ้าจะเรียกข้ามโดเมน)
export function withCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
}
