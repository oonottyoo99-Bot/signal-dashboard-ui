// api/run-scan.js
//
// เรียกแบบ: /api/run-scan?group=sp500&manual=1&offset=0&limit=25
// - อ่านรายชื่อจาก data/symbols.json
// - สแกน batch (offset..offset+limit)
// - เขียนผลลง data/signals-<group>.json และซ้ำลง data/signals.json (ผลล่าสุด)
// - ส่ง nextOffset กลับให้ UI loop ต่อ

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const group = String(req.query.group || "").trim();
    const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
    const limitRaw = parseInt(String(req.query.limit ?? "25"), 10) || 25;
    const limit = Math.max(1, Math.min(limitRaw, 100)); // กันเผื่อ

    if (!group) {
      return res.status(400).json({ ok: false, error: "missing ?group" });
    }

    const base =
      process.env.NEXT_PUBLIC_API_BASE ||
      `https://${req.headers.host ?? "localhost"}`;

    // 1) อ่าน symbols.json
    const symResp = await fetch(`${base}/api/github?op=read&path=data/symbols.json`, { cache: "no-store" });
    if (!symResp.ok) {
      const txt = await symResp.text().catch(() => "");
      return res.status(symResp.status).json({ ok: false, error: `read symbols failed: ${txt}` });
    }
    const symbols = await symResp.json().catch(() => ({}));
    const list = Array.isArray(symbols?.[group]) ? symbols[group] : null;

    if (!list || list.length === 0) {
      return res.status(400).json({ ok: false, error: `ไม่พบกลุ่ม ${group} ใน data/symbols.json` });
    }

    const total = list.length;
    const start = Math.max(0, offset);
    const end = Math.min(total, start + limit);
    const batch = list.slice(start, end);

    // 2) สแกน batch → ให้ค่า 1D/1W
    const scanned = [];
    for (const ticker of batch) {
      scanned.push(await scanOne(ticker));
    }

    const nowISO = new Date().toISOString();

    // 3) ดึงไฟล์ signals ของ "กลุ่มนี้" มา merge
    const groupPath = `data/signals-${group}.json`;
    let existing = { group, updatedAt: nowISO, results: [] };

    const readGroup = await fetch(`${base}/api/github?op=read&path=${encodeURIComponent(groupPath)}`, { cache: "no-store" });
    if (readGroup.ok) {
      try {
        const j = await readGroup.json();
        if (j && j.group === group && Array.isArray(j.results)) existing = j;
      } catch {}
    }

    const map = new Map();
    for (const r of existing.results) map.set(r.ticker, r);
    for (const r of scanned) map.set(r.ticker, r);

    const merged = Array.from(map.values());

    const payloadGroup = {
      group,
      updatedAt: nowISO,
      results: merged,
    };

    // 4) เขียนไฟล์ของกลุ่ม
    const writeGroup = await fetch(`${base}/api/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "write",
        path: groupPath,
        message: `update signals ${group}`,
        content: JSON.stringify(payloadGroup, null, 2),
      }),
    });
    if (!writeGroup.ok) {
      const txt = await writeGroup.text().catch(() => "");
      return res.status(422).json({ ok: false, error: `write group failed: ${txt}` });
    }

    // 5) เขียนซ้ำไฟล์ผลล่าสุด (เพื่อความเข้ากันได้กับหน้าที่อ่านรวม)
    await fetch(`${base}/api/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "write",
        path: "data/signals.json",
        message: `update signals latest -> ${group}`,
        content: JSON.stringify(payloadGroup, null, 2),
      }),
    }).catch(() => {});

    const done = end;
    const nextOffset = done < total ? done : null;

    return res.status(200).json({
      ok: true,
      group,
      total,
      done,
      wrote: scanned.length,
      nextOffset,
      updatedAt: nowISO,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err ?? "unknown error") });
  }
}

// ====== ที่นี่ใส่เงื่อนไข “อินดิเคเตอร์จริง” ของคุณได้ ======
async function scanOne(ticker) {
  // ตัวอย่างเดโม่: ให้ 1D/1W = "Sell" เหมือนกัน
  // TODO: แทนที่ด้วย logic จริง (EMA/RSI/ฯลฯ) สำหรับ 1D และ 1W
  const signalD = "Sell";
  const signalW = Math.random() < 0.5 ? null : "Buy"; // เดโม่ให้บางตัวมี 1W เพื่อเห็นสีเขียว

  return {
    ticker,
    // เข้ากันได้กับระบบเดิม:
    signal: signalD,
    price: null,
    timeframe: "1D",
    // โครงสร้างใหม่:
    signalD,
    signalW,             // มีค่า → UI ทำเป็นป้ายสีเขียว
    timeframes: ["1D"].concat(signalW ? ["1W"] : []),
  };
}
