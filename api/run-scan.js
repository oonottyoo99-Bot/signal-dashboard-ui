// api/run-scan.js
//
// Batch scanner + progress.
// - Query:
//     group=<string>                 (required)
//     manual=1                       (optional; เพียงใช้เพื่อบอก UI ว่าเป็น manual run)
//     offset=<int>                   (optional; start index for batching; default 0)
//     limit=<int>                    (optional; batch size; default 25)
// - Response: { ok, group, updatedAt, results, total, done, batch, nextOffset|null }
//
// ต้องมีไฟล์ data/symbols.json และ data/signals.json ใน repo เดียวกับโปรเจ็กต์
// ENV ที่ใช้ (ตั้งแล้วของคุณ):
//   GH_REPO, GH_REPO_SYMBOLS, GH_BRANCH, GH_TOKEN
//   GH_PATH_SETTINGS = data/settings.json
//   GH_PATH_SIGNALS  = data/signals.json
//
// NOTE: อาศัย helper ใน api/github.js ที่มีฟังก์ชัน ghReadJson(path, opts), ghWriteJson(path, json, opts)
//       โดย opts.repo = 'symbols' สำหรับอ่าน symbols.json จาก repo ตาม GH_REPO_SYMBOLS

import { NextResponse } from "next/server"; // ถ้าเป็น Next 13+ (Vercel) จะหาได้อัตโนมัติ
import { ghReadJson, ghWriteJson } from "./github"; // <- helper ที่คุณใช้อยู่แล้ว

// ค่าตั้งต้น batch
const DEFAULT_LIMIT = 25;

// path ไฟล์ใน repo (คุณตั้ง ENV แล้ว แต่สำรองค่า default กันพลาด)
const PATH_SYMBOLS = process.env.GH_PATH_SYMBOLS || "data/symbols.json";
const PATH_SIGNALS = process.env.GH_PATH_SIGNALS || "data/signals.json";

// ยูทิลแสดง error ชัด ๆ
function err(res, code, msg) {
  return res.status(code).json({ ok: false, error: msg });
}

// mock “สแกน” ง่าย ๆ (คุณจะค่อย ๆ เปลี่ยนเป็น logic indicator จริงของคุณก็ได้)
async function scanOne(ticker) {
  // ตรงนี้เอา indicator จริงมาเสียบได้เลย
  return {
    ticker,
    signal: "Sell",
    price: null,
    timeframe: "1D",
  };
}

// ทำ merge partial results เข้ากับของเดิมใน signals.json (เช่น batch ที่แล้วทำไว้)
function mergeResults(oldArr = [], batchArr = []) {
  const map = new Map();
  for (const r of oldArr) map.set(r.ticker, r);
  for (const r of batchArr) map.set(r.ticker, r);
  return Array.from(map.values());
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return err(res, 405, "Method not allowed");
    }

    const group = String(req.query.group || "").trim();
    if (!group) return err(res, 400, "missing ?group");

    // batch params
    const offset = Number.isFinite(Number(req.query.offset))
      ? Number(req.query.offset)
      : 0;
    const limit = Number.isFinite(Number(req.query.limit))
      ? Math.max(1, Number(req.query.limit))
      : DEFAULT_LIMIT;

    // 1) อ่าน symbols.json (จาก repo สัญลักษณ์)
    const symbolsJson = await ghReadJson(PATH_SYMBOLS, { repo: "symbols" });
    if (!symbolsJson || !symbolsJson[group]) {
      return err(res, 400, `ไม่พบกลุ่ม ${group} ใน ${PATH_SYMBOLS}`);
    }
    const allSymbols = symbolsJson[group]; // array
    const total = allSymbols.length;

    // ถ้าไม่พบสัญลักษณ์เลย ก็เขียน signals ว่าง ๆ
    if (total === 0) {
      const updatedAt = new Date().toISOString();
      const payload = {
        group,
        updatedAt,
        results: [],
        total,
        done: 0,
        batch: 0,
        nextOffset: null,
      };
      await ghWriteJson(PATH_SIGNALS, payload);
      return res.status(200).json({ ok: true, ...payload });
    }

    // 2) slice batch
    const start = Math.min(offset, total);
    const end = Math.min(start + limit, total);
    const batch = allSymbols.slice(start, end);

    // 3) ทำการสแกนเฉพาะใน batch
    const scanned = [];
    for (const tk of batch) {
      const r = await scanOne(tk);
      scanned.push(r);
    }

    // 4) อ่าน signals เดิม (เพื่อ merge)
    let oldSignals = null;
    try {
      oldSignals = await ghReadJson(PATH_SIGNALS);
    } catch (_) {
      oldSignals = null;
    }

    const updatedAt = new Date().toISOString();
    const base = oldSignals && oldSignals.group === group ? oldSignals : null;
    const mergedResults = mergeResults(base?.results || [], scanned);

    // 5) คำนวณ progress + next offset
    const done = end;
    const nextOffset = end < total ? end : null;

    const payload = {
      group,
      updatedAt,
      results: mergedResults,
      total,
      done,
      batch: batch.length,
      nextOffset,
    };

    // 6) เขียนกลับ signals.json
    await ghWriteJson(PATH_SIGNALS, payload);

    return res.status(200).json({ ok: true, ...payload });
  } catch (e) {
    return err(res, 500, `scan failed: ${String(e)}`);
  }
}
