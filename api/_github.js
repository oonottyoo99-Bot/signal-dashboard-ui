// api/_github.js
// ยูทิลสำหรับอ่าน/เขียนไฟล์ใน GitHub repo ของคุณ
// ใช้ได้ทั้งอ่านไฟล์ธรรมดา (ผ่าน raw.githubusercontent.com) และเขียนด้วย GitHub REST API

const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = process.env.GH_REPO;        // ตัวอย่าง: "oonottyoo99-Bot/signal-dashboard-ui"
const GH_BRANCH = process.env.GH_BRANCH || "main";

/** raw URL ของไฟล์ใน repo */
function rawUrl(path) {
  // path ห้ามขึ้นด้วย "/" (ให้เป็น data/symbols.json, api/signals.json ฯลฯ)
  const p = String(path).replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${encodeURI(p)}`;
}

/** GitHub REST API base */
function apiUrl(path) {
  const p = String(path).replace(/^\/+/, "");
  return `https://api.github.com/repos/${GH_REPO}/contents/${encodeURI(p)}`;
}

/** helper fetch JSON (โยน error พร้อม detail ถ้าไม่ได้ 2xx) */
async function fetchJson(url, init = {}) {
  const r = await fetch(url, init);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const msg = `HTTP ${r.status} ${url}${text ? ` :: ${text.slice(0, 300)}` : ""}`;
    throw new Error(msg);
  }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : r.text();
}

/** อ่านไฟล์ “ดิบ” จาก GitHub (raw) แล้ว parse JSON อัตโนมัติถ้าเป็น JSON */
export async function ghRead(path, { as = "json" } = {}) {
  const url = rawUrl(path);
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (as === "text") return await res.text();
    // json
    const txt = await res.text();
    try {
      return JSON.parse(txt);
    } catch (_) {
      // ถ้า parse ไม่ได้และ as=json ให้โยน error ชัดๆ
      throw new Error(`Invalid JSON at ${path}`);
    }
  } catch (e) {
    throw new Error(`ghRead ${path} -> ${e.message}`);
  }
}

/** ดึง sha ปัจจุบันของไฟล์ (เพื่อ update contents) ถ้าไม่มีให้คืน null */
async function getSha(path) {
  try {
    const data = await fetchJson(apiUrl(path), {
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    });
    return data && data.sha ? data.sha : null;
  } catch (e) {
    // ถ้า 404 ให้ถือว่าไฟล์ยังไม่มี
    const msg = String(e.message || "");
    if (msg.includes("HTTP 404")) return null;
    throw e;
  }
}

/** เขียนไฟล์ JSON/ข้อความ กลับเข้า GitHub (commit ใหม่) */
export async function ghWrite(path, content, { message = "update via API" } = {}) {
  const now = new Date().toISOString();
  const bodyText = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  const sha = await getSha(path);

  const body = {
    message,
    content: Buffer.from(bodyText, "utf8").toString("base64"),
    branch: GH_BRANCH,
  };
  if (sha) body.sha = sha;

  try {
    await fetchJson(apiUrl(path), {
      method: "PUT",
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { ok: true, path, at: now };
  } catch (e) {
    throw new Error(`ghWrite ${path} -> ${e.message}`);
  }
}
