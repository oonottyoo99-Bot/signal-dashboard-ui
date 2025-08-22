// /api/run-scan.js
import { readJsonFromGitHub, writeJsonToGitHub } from './github';

export const config = { runtime: 'nodejs' };

function nowISO() {
  return new Date().toISOString();
}

export default async function handler(req, res) {
  try {
    const { searchParams } = new URL(req.url, 'http://localhost');
    const group  = (searchParams.get('group') || '').trim();
    const manual = searchParams.get('manual') === '1';

    if (!group) return res.status(400).json({ error: 'missing group' });

    // 1) โหลดรายชื่อสัญลักษณ์จาก repo 'symbols'
    const symbolsJson = await readJsonFromGitHub('data/symbols.json', 'symbols');
    const list = symbolsJson?.[group];
    if (!Array.isArray(list) || list.length === 0) {
      return res.status(400).json({ error: `ไม่พบกลุ่ม ${group} ใน data/symbols.json` });
    }

    // 2) (ตัวอย่าง) คำนวณสัญญาณแบบ placeholder ก่อน
    // ตรงนี้คุณค่อยสลับเป็นสูตรจริง TF 1D/1W ได้ทันที
    const results = [];
    for (const ticker of list) {
      // mock: ให้ทุกตัว "Sell" เวลาทดสอบ — เพื่อดู flow การเขียนไฟล์
      results.push({
        ticker,
        signal: 'Sell',
        price: null,
        timeframe: '1D'
      });
    }

    const payload = {
      group,
      updatedAt: nowISO(),
      results
    };

    // 3) บันทึกผลลง GitHub (ไฟล์ signals.json ใน repo หลัก)
    const signalsPath = process.env.GH_PATH_SIGNALS || 'api/signals.json';
    await writeJsonToGitHub(signalsPath, payload, `update signals ${group}`);

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: 'scan failed', detail: String(e.message || e) });
  }
}
