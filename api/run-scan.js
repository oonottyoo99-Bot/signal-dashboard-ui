// api/run-scan.js
//
// ทำงานแบบ batch: ?group=sp500&manual=1&offset=0&limit=25
// - อ่านรายชื่อสัญลักษณ์จาก data/symbols.json
// - สแกนทีละช่วง (offset..offset+limit)
// - รวมผลลง data/signals.json (เก็บผลล่าสุดของกลุ่มที่สแกน)
// - คืน nextOffset เพื่อให้ UI loop ต่อได้
//
// ต้องมี helper /api/github ใช้งานอยู่แล้ว (op=read, op=write)

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { group, manual = "0" } = req.query;
    const offset = parseInt(req.query.offset ?? "0", 10);
    const limit = Math.min(parseInt(req.query.limit ?? "25", 10), 100);

    if (!group) {
      return res.status(400).json({ ok: false, error: "missing ?group" });
    }

    // base สำหรับเรียก helper ภายในโปรเจ็กต์นี้
    const base =
      process.env.NEXT_PUBLIC_API_BASE ||
      `https://${req.headers.host ?? "localhost"}`;

    // 1) อ่าน symbols.json
    const symResp = await fetch(
      `${base}/api/github?op=read&path=data/symbols.json`,
      { cache: "no-store" }
    );
    if (!symResp.ok) {
      const txt = await symResp.text().catch(() => "");
      return res
        .status(symResp.status)
        .json({ ok: false, error: `read symbols failed: ${txt}` });
    }
    const symbolsJson = await symResp.json();
    const list = Array.isArray(symbolsJson?.[group])
      ? symbolsJson[group]
      : null;

    if (!list || list.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: `ไม่พบกลุ่ม ${group} ใน data/symbols.json` });
    }

    // 2) จำกัดช่วง batch
    const total = list.length;
    const start = Math.max(0, offset);
    const end = Math.min(total, start + limit);
    const batch = list.slice(start, end);

    // 3) สแกน (ใส่สัญญาณ 1D และ 1W)
    const resultsBatch = [];
    for (const t of batch) {
      const r = await scanTicker(t);
      resultsBatch.push(r);
    }

    // 4) รวมกับ signals.json เดิม (เก็บเฉพาะกลุ่มปัจจุบัน)
    const nowISO = new Date().toISOString();
    let existing = { group, updatedAt: nowISO, results: [] };

    const sigResp = await fetch(
      `${base}/api/github?op=read&path=data/signals.json`,
      { cache: "no-store" }
    );
    if (sigResp.ok) {
      try {
        const sigJson = await sigResp.json();
        if (sigJson && sigJson.group === group && Array.isArray(sigJson.results))
          existing = sigJson;
      } catch {}
    }

    // รวมผลแบบ de-dup ต่อ ticker
    const map = new Map();
    for (const r of existing.results) map.set(r.ticker, r);
    for (const r of resultsBatch) map.set(r.ticker, r);

    const mergedResults = Array.from(map.values());

    const payload = {
      group,
      updatedAt: nowISO,
      results: mergedResults,
    };

    // 5) เขียนกลับ signals.json
    const writeResp = await fetch(`${base}/api/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "write",
        path: "data/signals.json",
        message: `update signals ${group}`,
        // helper จะจัดการขึ้น SHA ให้เอง
        content: JSON.stringify(payload, null, 2),
      }),
    });

    if (!writeResp.ok) {
      const txt = await writeResp.text().catch(() => "");
      return res
        .status(422)
        .json({ ok: false, error: `write signals failed: ${txt}` });
    }

    const nextOffset = end < total ? end : null;

    return res.status(200).json({
      ok: true,
      group,
      total,
      done: end,
      nextOffset,
      wrote: resultsBatch.length,
      updatedAt: nowISO,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: String(err ?? "unknown error") });
  }
}

/**
 * สแกนสัญลักษณ์ 1 ตัว
 * - ใส่สัญญาณ 1D และ 1W
 * - UI ใหม่จะอ่าน field signalD/signalW (ยังคง backward-compatible ด้วย field signal/timeframe)
 */
async function scanTicker(ticker) {
  // TODO: แทนที่ logic นี้ด้วยของจริง (ดึงราคา/อินดิเคเตอร์ ฯลฯ)
  // สำหรับเดโม ใส่สัญญาณ “Sell” ทั้ง 1D/1W
  const signalD = "Sell";
  const signalW = "Sell";

  return {
    ticker,
    // เพื่อความเข้ากันได้กับโค้ดเดิม:
    signal: signalD, // เดิมอ่านที่ field นี้
    price: null,
    timeframe: "1D",

    // โครงสร้างใหม่ (UI จะโชว์สองคอลัมน์แยกกัน):
    signalD, // ผลสำหรับ 1D
    signalW, // ผลสำหรับ 1W
    timeframes: ["1D", "1W"], // ให้ UI แสดงชิป 1D/1W
  };
}
