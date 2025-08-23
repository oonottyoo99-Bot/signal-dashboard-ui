// api/settings.js
export const config = { runtime: "edge" };

const ok = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      ...init.headers,
    },
    ...init,
  });

const err = (status, message, detail) =>
  ok({ error: message, detail: detail ? String(detail) : undefined }, { status });

async function readJsonBody(req) {
  try {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return await req.json();
    }
    // fallback: raw → JSON.parse
    const text = await req.text();
    return text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error("Invalid JSON body");
  }
}

async function ghRead(path) {
  const url = new URL(`${process.env.NEXT_PUBLIC_API_BASE || ""}/api/github`);
  url.searchParams.set("op", "read");
  url.searchParams.set("path", path);
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`read ${path} -> HTTP ${r.status}`);
  return await r.json();
}

async function ghWrite(path, json) {
  // helper write: ไม่ต้องส่ง sha, ฝั่ง /api/github จะหามาให้เอง
  const url = new URL(`${process.env.NEXT_PUBLIC_API_BASE || ""}/api/github`);
  url.searchParams.set("op", "write");
  url.searchParams.set("path", path);

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`write ${path} -> HTTP ${r.status} ${t}`);
  }
  return await r.json();
}

export default async function handler(req) {
  const method = req.method || "GET";

  // preflight
  if (method === "OPTIONS") {
    return ok({ ok: true });
  }

  const settingsPath = process.env.GH_PATH_SETTINGS || "data/settings.json";

  if (method === "GET") {
    try {
      const json = await ghRead(settingsPath);
      // โครงสร้าง fallback
      const out = {
        auto_scan_groups: Array.isArray(json?.auto_scan_groups)
          ? json.auto_scan_groups
          : [],
      };
      return ok(out);
    } catch (e) {
      return err(500, "Cannot read settings", e);
    }
  }

  if (method === "POST") {
    try {
      const body = await readJsonBody(req);
      const arr = body?.auto_scan_groups;
      if (!Array.isArray(arr))
        return err(400, "payload must be { auto_scan_groups: string[] }");

      // normalize: string[], unique, lowercase
      const normalized = [...new Set(arr.map((s) => String(s).trim()))].filter(
        (s) => s
      );

      const toSave = { auto_scan_groups: normalized };
      await ghWrite(settingsPath, toSave);

      return ok({ ok: true, saved: toSave });
    } catch (e) {
      return err(500, "Cannot save settings", e);
    }
  }

  return err(405, "Method not allowed");
}
