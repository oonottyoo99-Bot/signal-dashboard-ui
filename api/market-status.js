// api/market-status.js
// Return live-ish market status per group: { group, open: boolean, source, note }

export default async function handler(req, res) {
  try {
    const nowUtc = new Date();

    const out = {};
    // Crypto: ใช้ system status จริง
    out.binance_top200 = await binanceStatus();
    out.okx_top200     = await okxStatus();
    out.altcoins       = out.okx_top200; // ใช้ OKX เดียวกัน
    out.bitkub         = await bitkubStatus();

    // US Equities/ETF: เปิด-ปิดตามตลาด NY (9:30–16:00 ET, จันทร์–ศุกร์) + วันหยุดหลัก
    out.sp500  = usEquityClock(nowUtc);
    out.nasdaq100 = out.sp500;
    out.etfs   = out.sp500;

    // SET: ชั่วโมงตลาดไทย + วันหยุดไทย
    out.set50  = setClock(nowUtc);
    out.set100 = out.set50;

    // Gold/FX: เปิดอา 22:00 UTC ถึง ศ 21:00 UTC (24/5)
    out.gold   = fx247Clock(nowUtc);

    res.status(200).json({ ok:true, ts: nowUtc.toISOString(), status: out });
  } catch (e) {
    console.error("market-status error:", e);
    res.status(500).json({ ok:false, error: String(e) });
  }
}

/* ================= Crypto status ================= */

async function binanceStatus(){
  try {
    const r = await fetch("https://api.binance.com/sapi/v1/system/status");
    if (!r.ok) throw new Error(String(r.status));
    const js = await r.json(); // {status:0|1, msg:"normal|system maintenance"}
    return {
      open: js.status === 0,
      source: "binance system",
      note: js.msg || "ok"
    };
  } catch (e) {
    return { open: true, source: "binance system", note: "fallback open" };
  }
}
async function okxStatus(){
  try {
    const r = await fetch("https://www.okx.com/api/v5/system/status");
    // okx status endpoint มักคืนรายการเหตุการณ์; ถ้า 200 ให้ถือว่าเปิด
    return { open: r.ok, source: "okx system", note: r.ok ? "ok" : `http ${r.status}` };
  } catch {
    return { open: true, source: "okx system", note: "fallback open" };
  }
}
async function bitkubStatus(){
  try {
    const r = await fetch("https://api.bitkub.com/api/status");
    if (!r.ok) throw new Error(String(r.status));
    const js = await r.json(); // {status:1}
    return { open: js.status === 1, source: "bitkub system", note: `status=${js.status}` };
  } catch {
    return { open: true, source: "bitkub system", note: "fallback open" };
  }
}

/* ================= US equities clock (no key) ================= */
// 9:30–16:00 America/New_York, Mon–Fri; หยุดตามวันหยุดหลัก
function usEquityClock(nowUtc){
  const nyOffset = -4; // EDT ~ UTC-4 (ปรับตามฤดูกาลได้ง่ายๆ: ถ้าอยากชัวร์ ใช้ไลบรารี tz)
  const ny = new Date(nowUtc.getTime() + nyOffset*3600*1000);
  const day = ny.getUTCDay(); // 0=Sun..6=Sat (แต่ในโซนเดิม)
  const h   = ny.getUTCHours();
  const m   = ny.getUTCMinutes();
  const isWeekday = day >= 1 && day <= 5;
  const isHoliday = isUsHoliday(ny);

  const open = isWeekday && !isHoliday && timeInRange(h,m,  9,30, 16,0);
  return { open, source: "ny clock", note: `NY ${pad(h)}:${pad(m)} ${isHoliday?'holiday':''}`.trim() };
}
// ตัวอย่างวันหยุด (ย่อ) — เพิ่มได้
function isUsHoliday(d){
  const y = d.getUTCFullYear();
  const mmdd = (m,d)=>`${m.toString().padStart(2,'0')}-${d.toString().padStart(2,'0')}`;
  const set = new Set([
    `${y}-01-01`, // New Year
    `${y}-07-04`, // Independence
    `${y}-12-25`, // Christmas
  ]);
  const s = `${y}-${mmdd(d.getUTCMonth()+1, d.getUTCDate())}`;
  return set.has(s);
}

/* ================= SET (กทม) ================= */
// เปิด 10:00–12:30 และ 14:30–16:30 Asia/Bangkok, จันทร์–ศุกร์ + วันหยุดไทย (ย่อ)
function setClock(nowUtc){
  const bkkOffset = +7; // UTC+7
  const bkk = new Date(nowUtc.getTime() + bkkOffset*3600*1000);
  const day = bkk.getUTCDay();
  const h = bkk.getUTCHours(), m = bkk.getUTCMinutes();
  const isWeekday = day >= 1 && day <= 5;
  const isHoliday = isThaiHoliday(bkk);

  const s1 = timeInRange(h,m,10,0,12,30);
  const s2 = timeInRange(h,m,14,30,16,30);
  const open = isWeekday && !isHoliday && (s1 || s2);
  return { open, source: "bkk clock", note: `BKK ${pad(h)}:${pad(m)} ${isHoliday?'holiday':''}`.trim() };
}
function isThaiHoliday(d){
  const y = d.getUTCFullYear();
  const mmdd = (m,d)=>`${m.toString().padStart(2,'0')}-${d.toString().padStart(2,'0')}`;
  const set = new Set([
    `${y}-01-01`, // New Year
    `${y}-04-13`, // Songkran (approx)
    `${y}-12-05`, // Father’s Day (approx)
  ]);
  const s = `${y}-${mmdd(d.getUTCMonth()+1, d.getUTCDate())}`;
  return set.has(s);
}

/* ================= Gold/FX clock ================= */
// เปิด อา 22:00 UTC ถึง ศ 21:00 UTC
function fx247Clock(nowUtc){
  const wd = nowUtc.getUTCDay();
  const h  = nowUtc.getUTCHours();
  const open =
    (wd === 0 && h >= 22) ||           // Sun 22:00+
    (wd >= 1 && wd <= 4) ||            // Mon..Thu (all)
    (wd === 5 && h < 21);              // Fri < 21:00
  return { open, source: "fx clock", note: `UTC ${pad(h)}:${pad(nowUtc.getUTCMinutes())}` };
}

/* ================= helpers ================= */
function timeInRange(h,m, h1,m1, h2,m2){
  const t = h*60+m, a = h1*60+m1, b = h2*60+m2;
  return t >= a && t < b;
}
const pad = n => String(n).padStart(2,'0');
