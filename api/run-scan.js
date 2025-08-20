// /api/run-scan.js
export const config = { runtime: 'edge' };

// ===== Helper: fetch JSON safely =====
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// ===== Yahoo fetcher (DAY / WEEK) =====
// interval: '1d' | '1wk'
// range:    '6mo' | '1y' | '2y'
async function getYahooSeries(symbol, interval = '1d', range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=${interval}&range=${range}`;
  const j = await getJSON(url);
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`No chart for ${symbol}`);
  const closes = r.indicators?.quote?.[0]?.close || [];
  return closes.filter((x) => typeof x === 'number');
}

// ===== Technicals =====
function ema(arr, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = arr[0];
  out.push(prev);
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i] * k + prev * (1 - k);
    out.push(v);
    prev = v;
  }
  return out;
}

function rsi(arr, period = 14) {
  if (arr.length < period + 1) return Array(arr.length).fill(50);
  const gains = [];
  const losses = [];
  for (let i = 1; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    gains.push(Math.max(0, diff));
    losses.push(Math.max(0, -diff));
  }
  const avgGain = ema(gains, period);
  const avgLoss = ema(losses, period);
  const out = [50];
  for (let i = 1; i < avgGain.length; i++) {
    const ag = avgGain[i];
    const al = avgLoss[i];
    const rs = al === 0 ? 100 : ag / al;
    out.push(100 - 100 / (1 + rs));
  }
  // align length
  while (out.length < arr.length) out.unshift(50);
  return out;
}

function macd(arr, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(arr, fast);
  const emaSlow = ema(arr, slow);
  const macdLine = arr.map((_, i) => (emaFast[i] ?? 0) - (emaSlow[i] ?? 0));
  const signalLine = ema(macdLine, signal);
  return { macdLine, signalLine };
}

function highest(arr, lookback) {
  if (arr.length < lookback) return Number.NEGATIVE_INFINITY;
  let max = arr[arr.length - lookback];
  for (let i = arr.length - lookback + 1; i < arr.length; i++) {
    if (arr[i] > max) max = arr[i];
  }
  return max;
}

function crossover(aPrev, aNow, bPrev, bNow) {
  return aPrev <= bPrev && aNow > bNow;
}
function crossunder(aPrev, aNow, bPrev, bNow) {
  return aPrev >= bPrev && aNow < bNow;
}

// ===== GitHub read/write via _github helper =====
async function ghRead(path) {
  const base = `${process.env.NEXT_PUBLIC_API_BASE || 'https://signal-dashboard-ui.vercel.app'}/api/_github?op=read&path=${encodeURIComponent(path)}`;
  const j = await getJSON(base);
  return j;
}

async function ghWrite(path, contentObj) {
  const base = `${process.env.NEXT_PUBLIC_API_BASE || 'https://signal-dashboard-ui.vercel.app'}/api/_github`;
  const r = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'write', path, content: JSON.stringify(contentObj, null, 2) })
  });
  if (!r.ok) {
    throw new Error(`GitHub write failed: ${await r.text()}`);
  }
  return r.json();
}

// ===== Telegram =====
async function pushTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function scanOne(symbol) {
  // DAY
  const day = await getYahooSeries(symbol, '1d', '1y');
  if (day.length < 60) return null;

  const ema9 = ema(day, 9);
  const ema21 = ema(day, 21);
  const { macdLine, signalLine } = macd(day, 12, 26, 9);
  const rsi14 = rsi(day, 14);
  const last = day.length - 1;

  const isCrossUp = crossover(ema9[last - 1], ema9[last], ema21[last - 1], ema21[last]);
  const isCrossDn = crossunder(ema9[last - 1], ema9[last], ema21[last - 1], ema21[last]);
  const macdAbove = macdLine[last] > signalLine[last];
  const macdBelow = macdLine[last] < signalLine[last];
  const rsiLo = rsi14[last] < 70;
  const rsiHi = rsi14[last] > 80;

  // Breakout 20 แท่งย้อนหลัง (ดูจากราคาปิด)
  const priorHigh = highest(day.slice(0, -1), 20);
  const isBreakout = day[last] > priorHigh;

  let signal = '-';
  if (isCrossUp && macdAbove && rsiLo) {
    signal = isBreakout ? 'Strong Buy' : 'Buy';
  } else if (isCrossDn || macdBelow || rsiHi) {
    signal = 'Sell';
  }

  // WEEK (optional — ใช้ประกอบแจ้งเตือน)
  const week = await getYahooSeries(symbol, '1wk', '2y');
  let signalW = '-';
  if (week.length > 60) {
    const e9 = ema(week, 9);
    const e21 = ema(week, 21);
    const { macdLine: mW, signalLine: sW } = macd(week, 12, 26, 9);
    const rW = rsi(week, 14);
    const L = week.length - 1;
    const upW = crossover(e9[L - 1], e9[L], e21[L - 1], e21[L]);
    const dnW = crossunder(e9[L - 1], e9[L], e21[L - 1], e21[L]);
    const macdUp = mW[L] > sW[L];
    const macdDn = mW[L] < sW[L];
    const rLo = rW[L] < 70;
    const rHi = rW[L] > 80;
    const pHigh = highest(week.slice(0, -1), 20);
    const bo = week[L] > pHigh;
    if (upW && macdUp && rLo) signalW = bo ? 'Strong Buy' : 'Buy';
    else if (dnW || macdDn || rHi) signalW = 'Sell';
  }

  return {
    ticker: symbol,
    signal,
    signalW,
    price: Number(day[last].toFixed(2)),
    timeframe: '1D'
  };
}

export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const group = (searchParams.get('group') || '').trim();
    const manual = searchParams.get('manual') === '1'; // manual override

    if (!group) {
      return new Response(JSON.stringify({ error: 'ต้องใส่ ?group=...' }, null, 2), { status: 400 });
    }

    // 1) โหลด settings เพื่อเช็คสวิตช์
    //    ตัวอย่าง settings.json:
    //    { "auto_scan_enabled": true, "auto_scan_groups": ["sp500","nasdaq100"] }
    const settings = await ghRead(process.env.GH_PATH_SETTINGS || 'api/settings.json');

    // ถ้าเป็นการรันจาก Cron (ไม่ใส่ manual=1) และปิดออโต้ไว้ → ยกเลิก
    if (!manual && settings && settings.auto_scan_enabled === false) {
      return new Response(JSON.stringify({ skipped: true, reason: 'auto_scan_disabled' }, null, 2), { status: 200 });
    }

    // 2) โหลด symbol list ของกลุ่ม
    const symbolsData = await ghRead('data/symbols.json');
    const list = symbolsData?.[group];
    if (!Array.isArray(list) || list.length === 0) {
      return new Response(
        JSON.stringify({ error: `ไม่พบกลุ่ม ${group} ใน data/symbols.json` }, null, 2),
        { status: 400 }
      );
    }

    // 3) สแกนทีละตัว (ถ้าจำนวนมากค่อยเพิ่ม throttle/batch)
    const results = [];
    for (const sym of list) {
      try {
        const r = await scanOne(sym);
        if (r && r.signal && r.signal !== '-') {
          results.push(r);
        }
      } catch (e) {
        // เงียบไว้ — ข้ามตัวที่ดึงไม่ได้
      }
    }

    // 4) บันทึกไฟล์ signals.json (เฉพาะรายการที่มีสัญญาณเท่านั้น)
    const payload = {
      group,
      updatedAt: new Date().toISOString(),
      results
    };
    await ghWrite(process.env.GH_PATH_SIGNALS || 'api/signals.json', payload);

    // 5) แจ้งเตือน Telegram เฉพาะ Strong Buy/Buy (1D/1W)
    const toNotify = results.filter((x) => x.signal === 'Strong Buy' || x.signal === 'Buy');
    if (toNotify.length > 0) {
      const lines = [
        `📣 Scan ${group} @ ${payload.updatedAt}`,
        ...toNotify.map(
          (x) => `• ${x.ticker} — ${x.signal} (price ${x.price})`
        )
      ];
      await pushTelegram(lines.join('\n'));
    }

    return new Response(JSON.stringify(payload, null, 2), {
      headers: { 'content-type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'scan failed', detail: String(e) }, null, 2), { status: 500 });
  }
}
