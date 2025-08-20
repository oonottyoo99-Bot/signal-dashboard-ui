// /api/_github.js
// Helper สำหรับอ่าน/เขียนไฟล์ JSON บน GitHub ด้วย Personal Access Token
// ใช้กับไฟล์ signals.json / settings.json ที่เก็บใน repo อื่นได้ (หรือ repo เดียวกันก็ได้)

// ===== 1) อ่าน ENV =====
const TOKEN =
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN || // เผื่อบางโปรเจ็กต์ใช้ชื่อนี้
  "";

if (!TOKEN) {
  console.warn("[_github] Missing GH_TOKEN/GITHUB_TOKEN env.");
}

const REPO = process.env.GH_REPO || ""; // รูปแบบ owner/repo เช่น oONOTTYOo99-Bot/oONOTTYOo99-Alert
const BRANCH = process.env.GH_BRANCH || "main";

// เส้นทางไฟล์ที่ “ต้องตรงกับของจริงใน repo นั้นๆ”
const PATH_SIGNALS = process.env.GH_PATH_SIGNALS || "api/signals.json";
const PATH_SETTINGS = process.env.GH_PATH_SETTINGS || "api/settings.json";

// ===== 2) ยูทิลพื้นฐานของ GitHub REST =====
const API = "https://api.github.com";

function ghHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

async function gh(path, init) {
  const url = `${API}${path}`;
  const res = await fetch(url, { ...init, headers: ghHeaders() });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`GitHub API ${res.status} ${res.statusText}: ${body}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// อ่านไฟล์ (ได้ทั้ง SHA และเนื้อหา)
async function readFile(path) {
  // GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
  return gh(
    `/repos/${REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(
      BRANCH
    )}`,
    { method: "GET" }
  );
}

// สร้าง/อัปเดตไฟล์
async function writeFile(path, contentStr, message, sha /* optional */) {
  // PUT /repos/{owner}/{repo}/contents/{path}
  const body = {
    message,
    content: Buffer.from(contentStr, "utf8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  return gh(`/repos/${REPO}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// ===== 3) ฟังก์ชัน JSON ระดับสูง =====
export async function readJson(path) {
  try {
    const file = await readFile(path);
    const decoded = Buffer.from(file.content, "base64").toString("utf8");
    return { sha: file.sha, data: JSON.parse(decoded) };
  } catch (e) {
    if (e.status === 404) {
      // ไม่มีไฟล์ -> คืน default ว่าง
      return { sha: null, data: null };
    }
    throw e;
  }
}

export async function writeJson(path, json, commitMsg = "update json") {
  // อ่านก่อนเพื่อเอา sha (ถ้ามี)
  const old = await readJson(path);
  const str = JSON.stringify(json, null, 2);
  return writeFile(path, str, commitMsg, old.sha || undefined);
}

// ===== 4) ฟังก์ชันเฉพาะ signals/settings =====
export async function readSignals() {
  const r = await readJson(PATH_SIGNALS);
  // ถ้ายังไม่มีไฟล์ ให้คืนโครงสร้างว่างมาตรฐาน
  return (
    r.data || {
      group: "-",
      updatedAt: null,
      results: [],
    }
  );
}

export async function writeSignals(payload) {
  // payload ควรเป็น { group, updatedAt, results: [...] }
  return writeJson(PATH_SIGNALS, payload, "update signals.json");
}

export async function readSettings() {
  const r = await readJson(PATH_SETTINGS);
  return r.data || { auto_scan_groups: [] };
}

export async function writeSettings(settings) {
  // settings ควรเป็น { auto_scan_groups: [...] }
  return writeJson(PATH_SETTINGS, settings, "update settings.json");
}

// ===== 5) Debug helper (optional export) =====
export function debugEnv() {
  return {
    REPO,
    BRANCH,
    PATH_SIGNALS,
    PATH_SETTINGS,
    HAS_TOKEN: !!TOKEN,
  };
}
