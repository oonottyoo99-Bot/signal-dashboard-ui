// api/run-scan.js
import { readFileFromGitHub, writeFileToGitHub } from './_github.js';

// ---------- config ----------
const DEFAULT_TF = '1D';             // 1D หรือ 1W
const STOCK_SOURCE = 'yahoo';        // แหล่งข้อมูลหุ้น
const CRYPTO_SOURCE = 'binance';     // แหล่งข้อมูลคริปโต
const TELE_ENABLED = true;           // เปิด/ปิด ส่งเตือน Telegram

// กลุ่ม symbol ที่รองรับ (เติม/แก้ใน data/symbols.json จะดีที่สุด — ดูหัวข้อ B)
const FALLBACK_SYMBOLS = {
  sp500:    ["AAPL","MSFT","NVDA","META","SPY"],      // ตัวอย่าง; ใส่ครบ 500 ตัวในไฟล์ภายนอก
  nasdaq100:["AMZN","TSLA","GOOGL","QQQ","MSFT"],     // ตัวอย่าง; ใส่ครบ 100 ตัวในไฟล์ภายนอก
  etf:      ["QQQ","SPY","ARKK","VTI","DIA"],
  altcoins: ["ETHUSDT","XRPUSDT","ADAUSDT","MATICUSDT","SOLUSDT"],
  binance:  ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT"],
};

// ---------- helpers ----------
function toYahooSymbol(sym) {
  // สำหรับหุ้นไทย/ตลาดอื่นอาจต้องเติม suffix; ของคุณตอนนี้ us/etf ใช้ตรง ๆ ได้
  return sym;
}

async function fetchOHLCV_Stocks_Yahoo(symbol, tf, bars = 400) {
  // tf: '1D' หรือ '1W'
  const interval = tf === '1W' ? '1wk' : '1d';
  const rnd = Date.now();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    toYahooSymbol(symbol)
  )}?interval=${interval}&range=3y&_=${rnd}`;

  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Yahoo chart ${symbol} ${tf} ${r.status}`);
  const j = await r.json();

  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`Yahoo no data ${symbol}`);
  const ts = res.timestamp;
  const o = res.indicators?.quote?.[0]?.open || [];
  const h = res.indicators?.quote?.[0]?.high || [];
  const l = res.indicators?.quote?.[0]?.low || [];
  const c = res.indicators?.quote?.[0]?.close || [];
  const v = res.indicators?.quote?.[0]?.volume || [];

  const arr = [];
  for (let i = 0; i < ts.length; i++) {
    if (o[i] == null || h[i] == null || l[i] == null || c[i] == null || v[i] == null) continue;
    arr.push({ t: ts[i] * 1000, o: o[i], h: h[i], l: l[i], c: c[i], v: v[i] });
  }
  return arr.slice(-bars);
}

async function fetchOHLCV_Crypto_Binance(symbol, tf, bars = 800) {
  // tf: '1D'|'1W' → Binance: 1d / 1w
  const interval = tf === '1W' ? '1w' : '1d';
  const limit = Math.min(bars, 1000);
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance klines ${symbol} ${tf} ${r.status}`);
  const j = await r.json();
  return j.map(k => ({
    t: Number(k[0]),
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
  }));
}

// ---- TA utils (EMA, RSI, MACD, SMA) ----
function sma(values, length) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    out[i] = i >= length - 1 ? sum / length : null;
  }
  return out;
}
function ema(values, length) {
  const out = [];
  const k = 2 / (length + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    prev = i === 0 ? val : (val - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}
function rsi(values, length) {
  const out = new Array(values.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    gain += Math.max(ch, 0);
    loss += Math.max(-ch, 0);
    if (i === length) {
      const rs = loss === 0 ? 100 : gain / loss;
      out[i] = 100 - 100 / (1 + rs);
    } else if (i > length) {
      gain = (gain * (length - 1) + Math.max(ch, 0)) / length;
      loss = (loss * (length - 1) + Math.max(-ch, 0)) / length;
      const rs = loss === 0 ? 100 : gain / loss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}
function macd(values, fast = 12, slow = 26, signal = 9) {
  const fastE = ema(values, fast);
  const slowE = ema(values, slow);
  const macdLine = values.map((_, i) =>
    fastE[i] != null && slowE[i] != null ? fastE[i] - slowE[i] : null
  );
  const signalLine = ema(macdLine.map(x => (x == null ? 0 : x)), signal).map((v, i) =>
    macdLine[i] == null ? null : v
  );
  const hist = macdLine.map((v, i) => (v == null || signalLine[i] == null ? null : v - signalLine[i]));
  return { macdLine, signalLine, hist };
}

function highest(values, length, idx) {
  let max = -Infinity;
  for (let i = idx - length + 1; i <= idx; i++) max = Math.max(max, values[i]);
  return max;
}
function crossOver(a, b, i) {
  const prev = i - 1;
  if (prev < 0) return false;
  return a[prev] != null && b[prev] != null && a[i] != null && b[i] != null && a[prev] <= b[prev] && a[i] > b[i];
}
function crossUnder(a, b, i) {
  const prev = i - 1;
  if (prev < 0) return false;
  return a[prev] != null && b[prev] != null && a[i] != null && b[i] != null && a[prev] >= b[prev] && a[i] < b[i];
}

// ----- core per-symbol scan -----
function evaluateSignals(ohlcv) {
  const c = ohlcv.map(x => x.c);
  const v = ohlcv.map(x => x.v);
  const ema9 = ema(c, 9);
  const ema21 = ema(c, 21);
  const rsi14 = rsi(c, 14);
  const { macdLine, signalLine } = macd(c, 12, 26, 9);
  const volMA20 = sma(v, 20);

  const i = c.length - 1;
  // breakout: close > highest high ของ 20 แท่งก่อนหน้า (ยกเว้นแท่งล่าสุด)
  const priorHigh = highest(ohlcv.map(x => x.h), 20, i - 1);
  const breakout = c[i] > priorHigh && v[i] > (volMA20[i] ?? 0);

  const buy = crossOver(ema9, ema21, i) && (macdLine[i] ?? -999) > (signalLine[i] ?? 999) && (rsi14[i] ?? 0) < 70;
  const strongBuy = buy && breakout;
  const sell = crossUnder(ema9, ema21, i) || (macdLine[i] ?? 0) < (signalLine[i] ?? 0) || (rsi14[i] ?? 0) > 80;

  let signal = '-';
  if (strongBuy) signal = 'Strong Buy';
  else if (buy) signal = 'Buy';
  else if (sell) signal = 'Sell';

  return { signal, price: Number(c[i]?.toFixed(2)) };
}

async function fetchSeries(symbol, tf) {
  // ตัดสินใจจากรูปแบบ symbol แบบง่าย ๆ
  const isCrypto = /USDT$/.test(symbol) || /USD$/.test(symbol);
  if (isCrypto) {
    if (CRYPTO_SOURCE === 'binance') return fetchOHLCV_Crypto_Binance(symbol, tf);
    throw new Error('Unsupported crypto source');
  } else {
    if (STOCK_SOURCE === 'yahoo') return fetchOHLCV_Stocks_Yahoo(symbol, tf);
    throw new Error('Unsupported stock source');
  }
}

// ---------- Telegram ----------
async function notifyTelegram(text) {
  if (!TELE_ENABLED) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

// ---------- symbols ----------
async function loadSymbols(group) {
  // ถ้าใน GitHub repo มีไฟล์ data/symbols.json → ใช้ไฟล์นั้นก่อน (แนะนำให้สร้าง)
  try {
    const raw = await readFileFromGitHub('data/symbols.json');
    const j = JSON.parse(raw);
    if (Array.isArray(j[group]) && j[group].length) return j[group];
  } catch (_) {}
  // fallback
  return FALLBACK_SYMBOLS[group] || [];
}

// ---------- handler ----------
export default async function handler(req, res) {
  try {
    const group = (req.query.group || '').toLowerCase();
    if (!group) return res.status(400).json({ error: 'ต้องใส่ ?group=...' });
    const tf = (req.query.tf || DEFAULT_TF).toUpperCase(); // 1D / 1W

    const symbols = await loadSymbols(group);
    if (!symbols.length) return res.status(400).json({ error: `ไม่รู้จัก group: ${group}` });

    const results = [];
    // *** สแกน "ทุกตัว" ในกลุ่ม ***
    for (const sym of symbols) {
      try {
        const series = await fetchSeries(sym, tf);
        if (!series || series.length < 60) continue;
        const { signal, price } = evaluateSignals(series);
        // แสดงเฉพาะมีสัญญาณ หรือจะโชว์ทั้งหมดก็ได้ (บรรทัดถัดไป)
        if (signal !== '-') {
          results.push({ ticker: sym, signal, price, timeframe: tf });
        }
      } catch (e) {
        // ข้ามตัวที่ดึงไม่ได้
      }
    }

    const payload = {
      group,
      updatedAt: new Date().toISOString(),
      results,
    };

    // บันทึกลง GitHub
    await writeFileToGitHub(process.env.GH_PATH_SIGNALS || 'signals.json', JSON.stringify(payload, null, 2), `scan ${group} ${tf}`);

    // แจ้งเตือนถ้ามีสัญญาณ
    if (results.length) {
      const lines = results.slice(0, 10).map(r => `• ${r.ticker} — <b>${r.signal}</b> @ ${r.price} (${r.timeframe})`);
      await notifyTelegram(`✅ Scan <b>${group}</b> (${tf})\n${lines.join('\n')}${results.length > 10 ? `\n...and ${results.length - 10} more` : ''}`);
    } else {
      await notifyTelegram(`ℹ️ Scan <b>${group}</b> (${tf}) — no signals`);
    }

    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: 'scan failed', detail: String(e) });
  }
}
