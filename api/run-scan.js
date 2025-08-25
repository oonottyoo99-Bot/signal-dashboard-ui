// api/run-scan.js
import { ghRead, ghWriteJson } from "./github.js"; // ใช้ helper ใหม่ที่คุณใช้จริงอยู่
import { NextResponse } from "next/server";

// ตัวช่วยง่าย ๆ
async function readJsonFromRepo(path) {
  const json = await ghRead(path);
  if (!json || typeof json !== "object") {
    throw new Error(`read ${path} failed`);
  }
  return json;
}

// สแกนสัญลักษณ์: mock อินดิเคเตอร์ให้คืนค่า "Sell" พร้อม timeframe 1D (คุณปรับ logic ได้)
async function scanOne(ticker) {
  return {
    ticker,
    signal: "Sell",
    price: null,
    timeframe: "1D",
  };
}

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const group = (searchParams.get("group") || "").trim();
    const isManual = searchParams.get("manual") === "1";

    if (!group) {
      // อย่าโยน 400 ให้ UI error — ให้ตอบ 200 พร้อมเหตุผล
      return NextResponse.json({ ok: false, reason: "missing group" });
    }

    // อ่าน symbols.json จาก repo
    const symbols = await readJsonFromRepo("data/symbols.json");

    // รองรับทุก key ที่มีในไฟล์ (ไม่ล็อก whitelist)
    const list = symbols[group];
    if (!Array.isArray(list)) {
      return NextResponse.json({ ok: false, reason: `group "${group}" not found in data/symbols.json` });
    }
    if (list.length === 0) {
      // ไม่สแกน แต่ตอบ 200 เพื่อไม่ขึ้น HTTP error ใน UI
      return NextResponse.json({
        ok: true,
        group,
        updatedAt: new Date().toISOString(),
        results: [],
        note: "no symbols in this group"
      });
    }

    // สแกนทีละตัว (ทำทีละตัวพอ ไม่ต้องซับซ้อน)
    const results = [];
    for (const t of list) {
      const r = await scanOne(t);
      results.push(r);
    }

    const payload = {
      group,
      updatedAt: new Date().toISOString(),
      results,
    };

    // เขียนผลล่าสุดลง data/signals.json
    await ghWriteJson("data/signals.json", payload, {
      message: `update signals ${group}`,
    });

    // manual/auto ใช้ตัวเดียวกัน — ตอบกลับผล
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "scan failed", detail: String(err) }
    );
  }
}
