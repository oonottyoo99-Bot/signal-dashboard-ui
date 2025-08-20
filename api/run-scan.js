// api/run-scan.js
// ทำงานบน Vercel Edge/Serverless
// สิ่งที่ทำ: อ่านรายชื่อกลุ่มจาก data/symbols.json → ดึงราคา/แท่งเทียน → คำนวณ EMA/RSI/MACD + Breakout
// คัดเฉพาะ Strong Buy / Buy / Sell เท่านั้น → เขียนผลลง signals.json บน GitHub → ส่ง Telegram อัตโนมัติ

import { readJson, writeJson } from './_github.js';

// =============== ENV ===============
const GH_PATH_SIGNALS = process.env.GH_PATH_SIGNALS || 'api/signals.json';
const GH_PATH_SETTINGS = process.env.GH_PATH_SETTINGS || 'api/settings.json';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
// throttle เพื่อไม่ให้ยิงเร็วเกิน (มิลลิวินาที/ต่อ 1 symbol)
const PER_SYMBOL_DELAY_MS = 400;

// =============== Utils ===============
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

function ema(values, length) {
  const k = 2 / (length + 1);
  let emaPrev = values[0];
  const out = [emaPrev];
  for (let i = 1; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
    out.push(emaPrev);
  }
  return out;
}

function rsi(values, length = 14) {
  if (values.length < length + 1) return [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= length; i++) {
    const chg = values[i] - values[i - 1];
    if (chg >= 0) gains += chg; else losses -= chg;
  }
  let avgGain = gains / length, avgLoss = losses / length;
  const out = [];
  out[length] = 100 - 100 / (1 + (avgGain / (avgLoss || 1e-9)));
  for (let i = length + 1; i < values.length; i++) {
    const chg = values[i] - values[i - 1];
    const gain = chg > 0 ? chg : 0;
    const loss = chg < 0 ? -chg : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    const rs = avgGain / (avgLoss || 1e-9);
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    (emaFast[i] !== undefined && emaSlow[i] !== undefined) ? (emaFast[i] - emaSlow[i]) : undefined
  );
  const valid = macdLine.filter(v => v !== undefined);
  const start = macdLine.findIndex(v => v !== undefined);
  const signalLineAll = ema(valid, signal);
  const signalLine = macdLine.map((v, i) => (i >= start ? signalLineAll[i - start] : undefined));
  const hist = macdLine.map((v, i) => (v !== undefined && signalLine[i] !== undefined ? v - signalLine[i] : undefined));
  return { macdLine, signalLine, hist };
}

// Yahoo Finance (unofficial) สำหรับหุ้น/ETF/ทอง
async function fetchYahooDaily(ticker, years = 2) {
  const range = `${years}y`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Yahoo fetch failed ${r.status}`);
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  return closes.filter(x => typeof x === 'number');
}

// Binance spot สำหรับคริปโท (เช่น BTCUSDT)
async function fetchBinanceDaily(symbol, limit = 300) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance fetch failed ${r.status}`);
  const arr = await r.json();
  // close = index 4
  return arr.map(k => parseFloat(k[4]));
}

// ตัดสินใจสัญญาณตาม logic Pine ที่คุณให้: EMA cross + MACD + RSI + Breakout แบบง่าย
function decideSignalFromCloses(closes) {
  if (!closes || closes.length < 60) return null;
  const fastLen = 9, slowLen = 21, rsiLen = 14, macdFast = 12, macdSlow = 26, macdSig = 9, volLook = 20, breakoutLook = 20;

  // ใช้ราคาแทน volume/EMA ของ volume (ที่นี่ไม่มี volume → ไม่ใช้เงื่อนไข volume)
  const emaFast = ema(closes, fastLen);
  const emaSlow = ema(closes, slowLen);
  const { macdLine, signalLine } = macd(closes, macdFast, macdSlow, macdSig);
  const rsiArr = rsi(closes, rsiLen);

  const i = closes.length - 1;
  const priorHigh = Math.max(...closes.slice(Math.max(0, i - breakoutLook), i));
  const breakout = closes[i] > priorHigh;

  const emaCrossUp = emaFast[i] > emaSlow[i] && emaFast[i - 1] <= emaSlow[i - 1];
  const emaCrossDown = emaFast[i] < emaSlow[i] && emaFast[i - 1] >= emaSlow[i - 1];
  const macdAbove = macdLine[i] !== undefined && signalLine[i] !== undefined && macdLine[i] > signalLine[i];
  const macdBelow = macdLine[i] !== undefined && signalLine[i] !== undefined && macdLine[i] < signalLine[i];
  const rsiVal = rsiArr[i] ?? 50;

  const buy = emaCrossUp && macdAbove && rsiVal < 70;
  const strongBuy = buy && breakout;
  const sell = emaCrossDown || macdBelow || rsiVal > 80;

  if (strongBuy) return 'Strong Buy';
  if (buy) return 'Buy';
  if (sell) return 'Sell';
  return null;
}

async function getClosesBySymbol(sym) {
  // ถ้าเป็นคริปโท (ลงท้าย USDT) ให้ไป Binance, ถ้าไม่ใช่ ไป Yahoo
  if (/USDT$/i.test(sym)) {
    return await fetchBinanceDaily(sym);
  } else {
    return await fetchYahooDaily(sym);
  }
}

async function telegramNotify(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
  }).catch(()=>{});
}

// =============== MAIN HANDLER ===============
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group = url.searchParams.get('group')?.toLowerCase();
    if (!group) {
      return res.status(400).json({ error: 'ต้องใส่ ?group=...' });
    }

    // โหลดรายการ symbols
    const symbolsJson = await readJson('data/symbols.json'); // เราอ่านจากไฟล์ใน repo นี้เลย
    const list = symbolsJson[group];
    if (!Array.isArray(list) || list.length === 0) {
      return res.status(404).json({ error: `ไม่พบกลุ่ม ${group} ใน data/symbols.json` });
    }

    // สแกนทีละตัว + หน่วงเวลาเล็กน้อย
    const out = [];
    for (const ticker of list) {
      try {
        const closes = await getClosesBySymbol(ticker);
        const sig = decideSignalFromCloses(closes);
        if (sig) {
          out.push({
            ticker,
            signal: sig,
            price: Number(closes[closes.length - 1].toFixed(2)),
            timeframe: '1D'
          });
          if (sig === 'Strong Buy' || sig === 'Buy') {
            await telegramNotify(`✅ <b>${sig}</b> ${ticker} @ ${out[out.length-1].price} (TF 1D, group ${group})`);
          }
        }
      } catch (e) {
        // ข้ามตัวที่ดึงไม่ได้/ล้มเหลว
      }
      await sleep(PER_SYMBOL_DELAY_MS);
    }

    // โหลด/ผนวกผลเดิม (กันกรณี UI แสดงกลุ่มล่าสุด)
    const current = await readJson(GH_PATH_SIGNALS).catch(() => ({ group: '-', updatedAt: null, results: [] }));
    const next = { group, updatedAt: nowISO(), results: out };

    await writeJson(GH_PATH_SIGNALS, next);

    return res.json(next);
  } catch (err) {
    return res.status(500).json({ error: 'scan failed', detail: String(err) });
  }
}
