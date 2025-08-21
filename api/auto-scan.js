// api/auto-scan.js
export default async function handler(req, res) {
  try {
    // ฐาน URL ปัจจุบัน (รองรับทั้ง Prod/Preview)
    const base =
      process.env.NEXT_PUBLIC_API_BASE ||
      `https://${req.headers.host ?? "localhost"}`;

    // โหลด settings เพื่อดูว่ากลุ่มไหนเปิด auto
    const settingsResp = await fetch(`${base}/api/settings`);
    if (!settingsResp.ok) {
      const txt = await settingsResp.text();
      return res
        .status(500)
        .json({ ok: false, error: `read settings failed: ${txt}` });
    }
    const settings = await settingsResp.json();
    const groups = Array.isArray(settings.auto_scan_groups)
      ? settings.auto_scan_groups
      : [];

    if (groups.length === 0) {
      return res.json({
        ok: true,
        note: "no groups enabled in settings.auto_scan_groups",
        ran: [],
      });
    }

    const results = [];
    for (const g of groups) {
      // เรียก run-scan แบบ "auto" (ไม่ใส่ manual=1)
      const url = `${base}/api/run-scan?group=${encodeURIComponent(g)}`;
      let status = "ok";
      let detail = null;

      try {
        const r = await fetch(url, { method: "GET" });
        if (!r.ok) {
          status = "fail";
          detail = await r.text();
        } else {
          // อ่านผล (ไม่จำเป็นต้องใช้ แต่เผื่อ debug)
          await r.json().catch(() => null);
        }
      } catch (e) {
        status = "error";
        detail = String(e);
      }

      results.push({ group: g, status, detail });

      // หน่วงสั้น ๆ ลดโอกาสชน rate limit
      await new Promise((r) => setTimeout(r, 2500));
    }

    return res.json({ ok: true, ran: results });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: String(err ?? "unexpected error") });
  }
}
