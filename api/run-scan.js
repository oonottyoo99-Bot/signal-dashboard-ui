// /api/run-scan.js
// สแกนตามตรรกะจาก Pine Script: EMA9/21, RSI14, MACD 12/26/9, Volume MA20, Breakout(Highest High N)[1]
export default async function handler(req, res) {
  const group = (req.query.group || "").toString().toLowerCase();
  if (!group) return res.status(400).json({ error: "ต้องใส่ ?group=..." });

  try {
    const results = await scanGroup(group);

    // บันทึก signals.json กลับไปที่ GitHub
    const payload = {
      group,
      updatedAt: new Date().toISOString(),
      results,
    };
    await writeToGitHub(
      process.env.GH_REPO,
      process.env.GH_BRANCH || "main",
      process.env.GH_PATH_SIGNALS || "signals.json",
      JSON.stringify(payload, null, 2),
      process.env.GH_TOKEN,
      `scan ${group}`
    );

    res.status(200).json(payload);
  } catch (err) {
    console.error("run-scan error:", err);
    res.status(500).json({ error: "scan failed", detail: String(err) });
  }
}

/* --------------------------
   กลุ่มตัวอย่าง (ขยายได้)
--------------------------- */
const GROUP_MAP = {
  sp500: ["AAPL", "MSFT", "NVDA", "META", "SPY"],
  nasdaq100: ["AMZN", "TSLA", "GOOGL", "QQQ"],
  etf: ["SPY", "QQQ", "ARKK", "VTI", "DIA"],
  set50: ["PTT.BK", "CPALL.BK", "SCB.BK", "ADVANC.BK", "KBANK.BK"],
  set100: ["PTT.BK", "AOT.BK", "BDMS.BK", "CPN.BK", "CPALL.BK"],
  crypto: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"],
};

/* --------------- Core Scanner ------------------ */
async function scanGroup(group) {
  const tickers = GROUP_MAP[group] || [];
  if (tickers.length === 0) throw new Error(`unknown group: ${group}`);

  const tf = "4h"; // timeframe ที่ใช้สแกน
  const lookback = 200; // จำนวนแท่งที่ดึงมาคำนวณ

  const out = [];
  for (const t of tickers) {
    try {
      // ดึง OHLCV: หุ้น/ETF ใช้ Yahoo, Crypto ใช้ Binance
      const isCrypto = t.endsWith("USDT");
      const ohlcv = isCrypto
        ? await fetchBinance(t, tf, 500) // มากหน่อย
        : await fetchYahoo(t, "1d", "1y"); // หุ้นเอา 1D 1 ปี

      if (!ohlcv || ohlcv.c.length < 60) continue; // กันข้อมูลน้อยไป

      // คำนวณอินดิเคเตอร์
      const ema9 = ema(ohlcv.c, 9);
      const ema21 = ema(ohlcv.c, 21);
      const rsi14 = rsi(ohlcv.c, 14);
      const { macdLine, signalLine } = macd(ohlcv.c, 12, 26, 9);
      const volMA20 = sma(ohlcv.v, 20);

      const breakoutLb = 20;
      const priorHigh = highest(ohlcv.h, breakoutLb);
      // priorHigh[i] คือ highest high ของ 20 แท่ง "ก่อนหน้า" => ขยับ 1 แท่ง
      // จะถือ priorHighShift = priorHigh[i-1] (ทำง่าย ๆ เฉพาะแท่งล่าสุด)
      const last = ohlcv.c.length - 1;
      const priorHighShift = Math.max(0, last - 1) < priorHigh.length ? priorHigh[Math.max(0, last - 1)] : priorHigh[priorHigh.length - 1];
      const isBreakout = ohlcv.c[last] > priorHighShift && ohlcv.v[last] > volMA20[last];

      // เงื่อนไขสัญญาณ (ตาม Pine)
      const buy = crossOver(ema9, ema21) && macdLine[last] > signalLine[last] && rsi14[last] < 70;
      const strongBuy = buy && isBreakout;
      const sell =
        crossUnder(ema9, ema21) || macdLine[last] < signalLine[last] || rsi14[last] > 80;

      let signal = "-";
      if (strongBuy) signal = "Strong Buy";
      else if (buy) signal = "Buy";
      else if (sell) signal = "Sell";

      out.push({
        ticker: t,
        signal,
        price: round(ohlcv.c[last]),
        timeframe: isCrypto ? tf.toUpperCase() : "1D",
      });
    } catch (e) {
      console.error("scan error:", t, e);
    }
  }
  return out;
}

/* ------------------ Data Sources ------------------ */
// Yahoo Finance (หุ้น/ETF/หุ้นไทย .BK)
async function fetchYahoo(symbol, interval = "1d", range = "6mo") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=${interval}&range=${range}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Yahoo ${symbol} ${r.status}`);
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error("yahoo no result");

  const ts = result.timestamp || [];
  const o = result.indicators?.quote?.[0]?.open || [];
  const h = result.indicators?.quote?.[0]?.high || [];
  const l = result.indicators?.quote?.[0]?.low || [];
  const c = result.indicators?.quote?.[0]?.close || [];
  const v = result.indicators?.quote?.[0]?.volume || [];
  return { t: ts, o, h, l, c, v };
}

// Binance (คริปโต USDT)
async function fetchBinance(symbol = "BTCUSDT", interval = "4h", limit = 500) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${symbol} ${r.status}`);
  const arr = await r.json();
  const t = [];
  const o = [];
  const h = [];
  const l = [];
  const c = [];
  const v = [];
  for (const k of arr) {
    t.push(Math.floor(k[0] / 1000));
    o.push(+k[1]);
    h.push(+k[2]);
    l.push(+k[3]);
    c.push(+k[4]);
    v.push(+k[5]);
  }
  return { t, o, h, l, c, v };
}

/* ----------------- Indicators ----------------- */
function sma(src, len) {
  const out = Array(src.length).fill(null);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i] ?? 0;
    if (i >= len) sum -= src[i - len] ?? 0;
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

function ema(src, len) {
  const out = Array(src.length).fill(null);
  const k = 2 / (len + 1);
  let prev = src[0];
  out[0] = prev;
  for (let i = 1; i < src.length; i++) {
    const v = src[i];
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(src, len) {
  const out = Array(src.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const ch = src[i] - src[i - 1];
    gain += Math.max(ch, 0);
    loss += Math.max(-ch, 0);
  }
  let avgG = gain / len;
  let avgL = loss / len;
  out[len] = 100 - (100 / (1 + (avgL === 0 ? 100 : avgG / avgL)));
  for (let i = len + 1; i < src.length; i++) {
    const ch = src[i] - src[i - 1];
    const g = Math.max(ch, 0);
    const l = Math.max(-ch, 0);
    avgG = (avgG * (len - 1) + g) / len;
    avgL = (avgL * (len - 1) + l) / len;
    out[i] = 100 - (100 / (1 + (avgL === 0 ? 100 : avgG / avgL)));
  }
  return out;
}

function macd(src, fast = 12, slow = 26, signal = 9) {
  const emaF = ema(src, fast);
  const emaS = ema(src, slow);
  const macdLine = src.map((_, i) =>
    emaF[i] != null && emaS[i] != null ? emaF[i] - emaS[i] : null
  );
  const signalLine = ema(macdLine.map((x) => x ?? 0), signal);
  return { macdLine, signalLine };
}

function highest(arr, len) {
  const out = Array(arr.length).fill(null);
  for (let i = 0; i < arr.length; i++) {
    if (i < len - 1) continue;
    let m = -Infinity;
    for (let k = i - len + 1; k <= i; k++) m = Math.max(m, arr[k]);
    out[i] = m;
  }
  return out;
}

function crossOver(a, b) {
  const i = a.length - 1;
  if (i < 1) return false;
  return a[i - 1] != null && b[i - 1] != null && a[i] > b[i] && a[i - 1] <= b[i - 1];
}
function crossUnder(a, b) {
  const i = a.length - 1;
  if (i < 1) return false;
  return a[i - 1] != null && b[i - 1] != null && a[i] < b[i] && a[i - 1] >= b[i - 1];
}
const round = (n) => (n == null ? null : Math.round(n * 100) / 100);

/* ---------------- GitHub Writer ---------------- */
async function writeToGitHub(repo, branch, filePath, content, token, message) {
  if (!repo || !token) throw new Error("Missing GH_REPO or GH_TOKEN");

  const apiUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}`;
  // get sha if exists
  let sha;
  const head = await fetch(`${apiUrl}?ref=${branch}`, {
    headers: { Authorization: `token ${token}` },
  });
  if (head.ok) {
    const j = await head.json();
    sha = j.sha;
  }
  const put = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      message: message || "update via /api/run-scan",
      content: Buffer.from(content).toString("base64"),
      branch,
      sha,
    }),
  });
  if (!put.ok) {
    const txt = await put.text();
    throw new Error(`GitHub write failed: ${put.status} ${txt}`);
  }
}
