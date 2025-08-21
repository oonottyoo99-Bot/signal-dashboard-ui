// api/run-scan.js
import { ghRead, ghWrite } from "./_github";

const GH_PATH_SIGNALS = process.env.GH_PATH_SIGNALS || "api/signals.json";
const GH_PATH_SETTINGS = process.env.GH_PATH_SETTINGS || "api/settings.json";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

/* ---------- Utils: math indicators ---------- */

const ema = (arr, period) => {
  const k = 2 / (period + 1);
  let emaPrev = arr[0];
  const out = [emaPrev];
  for (let i = 1; i < arr.length; i++) {
    emaPrev = arr[i] * k + emaPrev * (1 - k);
    out.push(emaPrev);
  }
  return out;
};

const rsi = (arr, period = 14) => {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let rs = losses === 0 ? 100 : gains / losses;
  const out = [100 - 100 / (1 + rs)];
  for (let i = period + 1; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    gains = (gains * (period - 1) + gain) / period;
    losses = (losses * (period - 1) + loss) / period;
    rs = losses === 0 ? 100 : gains / losses;
    out.push(100 - 100 / (1 + rs));
  }
  // pad head
  const head = new Array(arr.length - out.length).fill(null);
  return head.concat(out);
};

const macd = (arr, fast = 12, slow = 26, signal = 9) => {
  const emaFast = ema(arr, fast);
  const emaSlow = ema(arr, slow);
  const macdLine = arr.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const hist = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, hist };
};

const highest = (arr, n, endIdx) => {
  let m = -Infinity;
  for (let i = Math.max(0, endIdx - n + 1); i <= endIdx; i++) m = Math.max(m, arr[i]);
  return m;
};

/* ---------- Data sources ---------- */

// Yahoo (stocks/ETF/Gold etc.)
async function yahooCloses(symbol, range = "6mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=${interval}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Yahoo ${symbol} HTTP ${r.status}`);
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  // ตัด null ท้ายๆออก
  return closes.filter((v) => typeof v === "number");
}

// Binance (crypto)
async function binanceCloses(symbol = "BTCUSDT", interval = "1d", limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Binance ${symbol} HTTP ${r.status}`);
  const arr = await r.json();
  return arr.map((row) => Number(row[4])); // close price
}

/* ---------- Signal logic ---------- */
function decideSignal(closes) {
  if (!closes || closes.length < 60) return { signal: null };

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const { macdLine, signalLine } = macd(closes, 12, 26, 9);
  const rsi14 = rsi(closes, 14);
  const i = closes.length - 1;

  const crossUp = ema9[i - 1] <= ema21[i - 1] && ema9[i] > ema21[i];
  const crossDown = ema9[i - 1] >= ema21[i - 1] && ema9[i] < ema21[i];
  const macdUp = macdLine[i] > signalLine[i];
  const macdDown = macdLine[i] < signalLine[i];
  const rsiOk = rsi14[i] < 70;
  const rsiOver = rsi14[i] > 80;

  const priorHigh = highest(closes, 20, i - 1);
  const breakout = closes[i] > priorHigh;

  if (crossUp && macdUp && rsiOk && breakout) return { signal: "STRONG_BUY" };
  if (crossUp && macdUp && rsiOk) return { signal: "BUY" };
  if (crossDown || macdDown || rsiOver) return { signal: "SELL" };

  return { signal: null };
}

/* ---------- Telegram ---------- */
async function notifyTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  }).catch(() => {});
}

/* ---------- Fetch & classify one symbol ---------- */
async function scanOne(symbol) {
  try {
    let closes;
    if (/USDT$/.test(symbol)) {
      // crypto on Binance
      closes = await binanceCloses(symbol, "1d", 200);
    } else {
      // yahoo for stocks/etf/commodities
      closes = await yahooCloses(symbol, "6mo", "1d");
    }
    const { signal } = decideSignal(closes);
    if (!signal) return null;

    const price = closes[closes.length - 1];
    return { ticker: symbol, signal, price: Number(price.toFixed(2)), timeframe: "1D" };
  } catch (_) {
    return null; // ข้ามตัวที่ดึงข้อมูลไม่ได้
  }
}

/* ---------- concurrency helper ---------- */
async function mapLimit(items, limit, fn) {
  const ret = [];
  const executing = [];
  for (const it of items) {
    const p = Promise.resolve().then(() => fn(it)).then((v) => v && ret.push(v));
    executing.push(p);
    if (executing.length >= limit) {
      await Promise.race(executing);
      // เคลียร์ตัวที่ resolve แล้ว
      for (let i = executing.length - 1; i >= 0; i--) {
        if (executing[i].status === "fulfilled" || executing[i].status === "rejected") {
          executing.splice(i, 1);
        }
      }
    }
  }
  await Promise.allSettled(executing);
  return ret;
}

/* ---------- main handler ---------- */
export default async function handler(req, res) {
  try {
    const group = String(req.query.group || "").toLowerCase().trim();
    const manual = String(req.query.manual || "") === "1";

    if (!group) {
      return res.status(400).json({ error: 'ต้องใส่ ?group=...' });
    }

    // 1) อ่าน settings เพื่อเช็ค auto-scan (ถ้า manual=1 ให้ข้าม)
    let canRun = true;
    if (!manual) {
      try {
        const settings = await ghRead(GH_PATH_SETTINGS);
        const arr = Array.isArray(settings?.auto_scan_groups) ? settings.auto_scan_groups : [];
        canRun = arr.map((x) => String(x).toLowerCase()).includes(group);
      } catch {
        // ถ้าอ่านไม่ได้ ให้ถือว่า allow (หรือเปลี่ยนเป็น false ก็ได้)
        canRun = true;
      }
      if (!canRun) {
        return res.status(200).json({ ok: false, reason: "auto-scan disabled for this group" });
      }
    }

    // 2) อ่านรายชื่อ symbols จาก GitHub raw
    const symbolsJson = await ghRead("data/symbols.json");
    const list = symbolsJson?.[group];
    if (!Array.isArray(list) || list.length === 0) {
      return res.status(404).json({ error: `ไม่พบกลุ่ม ${group} ใน data/symbols.json` });
    }

    // 3) สแกน (มีคัดเฉพาะที่ “มีสัญญาณ” เท่านั้น)
    const results = await mapLimit(list, 5, scanOne);

    const payload = {
      group,
      updatedAt: new Date().toISOString(),
      results,
    };

    // 4) บันทึกผลลง GitHub
    await ghWrite(GH_PATH_SIGNALS, payload, { message: `scan ${group}` });

    // 5) ส่ง Telegram เฉพาะ STRONG_BUY / BUY
    if (results && results.length) {
      const toSend = results.filter((r) => r.signal === "STRONG_BUY" || r.signal === "BUY");
      if (toSend.length) {
        const lines = toSend.map(
          (r) => `✅ ${r.signal}  ${r.ticker}  @ ${r.price} (${r.timeframe})`
        );
        await notifyTelegram(`🛰️ Scan ${group}\n` + lines.join("\n"));
      }
    }

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: "scan failed", detail: String(e.message || e) });
  }
}
