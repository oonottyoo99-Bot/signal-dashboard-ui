// api/run-scan.js
// v3 – full auto-batch scan + live symbols + TA (EMA/RSI/MACD) 1D & 1W + price(2d)

const BATCH_SIZE = 40;          // ประมวลผลต่อรอบ
const MAX_CONCURRENCY = 5;      // ยิง API พร้อมกันสูงสุด/รอบ
const MAX_ROUNDS = 999;         // กันลูป
const UA_HEADERS = { "User-Agent": "signal-dashboard/3.0" };

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const group = (url.searchParams.get("group") || "").toLowerCase();
    if (!group) return res.status(400).json({ error: "missing ?group" });

    // 1) โหลดรายชื่อสด (เชื่อถือได้ + ครบ)
    const allSymbols = await getSymbolsForGroupLiveOrFallback(group);
    if (!allSymbols.length) return res.status(400).json({ error: `no symbols for ${group}` });

    // 2) Auto-batch จนจบเอง (จะเขียน signals.json ทุก batch)
    let cursor = 0, round = 0, total = allSymbols.length, savedCount = 0;
    while (cursor < total && round < MAX_ROUNDS) {
      const slice = allSymbols.slice(cursor, Math.min(cursor + BATCH_SIZE, total));
      const scanned = await scanSymbols(slice, group);
      const mergedPayload = await mergeAndWriteSignals({
        group,
        updatedAt: new Date().toISOString(),
        results: scanned
      });
      cursor += slice.length;
      savedCount += scanned.length;
      round++;

      // ส่ง progress กลับครั้งเดียว (ให้ UI รู้ว่าไปต่อแล้ว)
      // หมายเหตุ: handler serverless ส่งทีเดียวตอนจบอยู่ดี – เลยสรุปผลครั้งเดียว
      if (cursor >= total) {
        return res.status(200).json({
          ok: true,
          version: "v3",
          group,
          total,
          processed: savedCount,
          batchSize: BATCH_SIZE,
          rounds: round,
          savedCount,
          savedPreview: mergedPayload
        });
      }
    }

    // safety
    return res.status(200).json({
      ok: true, version: "v3", group,
      note: "ended by MAX_ROUNDS", processed: savedCount, total
    });

  } catch (err) {
    console.error("run-scan error:", err);
    return res.status(500).json({ error: "scan failed", detail: String(err) });
  }
}

/* =============================== SCANNER =============================== */
// ดึงแท่งเทียน (both 1D & 1W) → คำนวณอินดิเคเตอร์ → ส่งสัญญาณ + ราคา(ล่าสุด 2dec)
async function scanSymbols(tickers, group) {
  // ทำเป็น queue จำกัด concurrency
  const out = [];
  let i = 0;
  async function worker() {
    while (i < tickers.length) {
      const idx = i++;
      const t = tickers[idx];
      try {
        const { ohlcD, ohlcW, lastPrice } = await fetchCandlesAll(group, t);
        const signalD = computeSignal(ohlcD);
        const signalW = computeSignal(ohlcW, true);
        out.push({
          ticker: t,
          signalD,
          signalW,
          price: lastPrice == null ? null : round2(lastPrice),
          timeframe: "1D"
        });
      } catch (e) {
        // ถ้าพลาดก็ใส่ "-" ไว้ก่อน แต่อย่างน้อยขึ้นแถว
        out.push({ ticker: t, signalD: "-", signalW: "-", price: null, timeframe: "1D" });
      }
    }
  }
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, tickers.length) }, () => worker());
  await Promise.all(workers);
  // เรียงชื่อเพื่อให้ deterministic
  out.sort((a,b)=> a.ticker.localeCompare(b.ticker));
  return out;
}

/* ============================ TA CALCULATION =========================== */
// เหมือน Pine ของคุณ (EMA 9/21, RSI 14, MACD 12/26/9) ให้ผล Buy/Sell/-
function computeSignal(ohlc, isWeekly=false) {
  try {
    if (!Array.isArray(ohlc) || ohlc.length < 60) return "-";
    // ราคาปิด
    const close = ohlc.map(x => x.c);
    // EMA
    const ema9  = ema(close, 9);
    const ema21 = ema(close, 21);
    // RSI 14
    const rsi14 = rsi(close, 14);
    // MACD 12/26/9
    const { macd, signal } = macdCalc(close, 12, 26, 9);

    const L = close.length - 1;
    if (L < 2) return "-";

    const crossUp   = ema9[L] > ema21[L] && ema9[L-1] <= ema21[L-1];
    const crossDown = ema9[L] < ema21[L] && ema9[L-1] >= ema21[L-1];

    const buy  = crossUp   && macd[L] > signal[L] && rsi14[L] < 70;
    const sell = crossDown || macd[L] < signal[L] || rsi14[L] > 80;

    if (buy && !sell)  return "Buy";
    if (sell && !buy)  return "Sell";
    return "-";
  } catch {
    return "-";
  }
}

// EMA
function ema(arr, period) {
  const k = 2/(period+1);
  let emaPrev = arr[0];
  const out = [emaPrev];
  for (let i=1;i<arr.length;i++){
    emaPrev = arr[i]*k + emaPrev*(1-k);
    out.push(emaPrev);
  }
  return out;
}
// RSI 14
function rsi(arr, period=14) {
  let gains=0, losses=0;
  for (let i=1;i<=period;i++){
    const ch = arr[i]-arr[i-1];
    if (ch>=0) gains+=ch; else losses-=ch;
  }
  let avgGain=gains/period, avgLoss=losses/period;
  const out = Array(arr.length).fill(50);
  out[period]= avgLoss===0?100: 100 - (100/(1+avgGain/avgLoss));
  for (let i=period+1;i<arr.length;i++){
    const ch=arr[i]-arr[i-1];
    const g= ch>0?ch:0, l= ch<0?-ch:0;
    avgGain=(avgGain*(period-1)+g)/period;
    avgLoss=(avgLoss*(period-1)+l)/period;
    out[i]= avgLoss===0?100: 100 - (100/(1+avgGain/avgLoss));
  }
  return out;
}
// MACD
function macdCalc(arr, fast=12, slow=26, sig=9) {
  const emaF = ema(arr, fast);
  const emaS = ema(arr, slow);
  const macd = arr.map((_,i)=>(emaF[i]-emaS[i]));
  const signal = ema(macd, sig);
  return { macd, signal };
}

/* ============================ LIVE SYMBOLS ============================= */
async function getSymbolsForGroupLiveOrFallback(group) {
  try {
    const live = await getSymbolsLive(group);
    if (Array.isArray(live) && live.length) return uniq(live);
  } catch (e) {
    console.warn(`[symbols-live] ${group} failed:`, e?.message || e);
  }
  // fallback → data/symbols.json (ถ้ามี)
  try {
    const json = await ghReadJSON(
      process.env.GH_PATH_SYMBOLS || "data/symbols.json",
      process.env.GH_REPO_SYMBOLS || process.env.GH_REPO,
      process.env.GH_BRANCH || "main"
    );
    return uniq(Array.isArray(json?.[group]) ? json[group] : []);
  } catch {
    return [];
  }
}

async function getSymbolsLive(group) {
  switch (group) {
    case "sp500":     return await fetchSP500Slickcharts();                    // 500
    case "nasdaq100": return await fetchNasdaq100Wikipedia();                  // 100
    case "altcoins":  return await fetchOKXTopN(100, true);                    // OKX top100 (ตัด stable/btc/eth)
    case "binance_top200": return await fetchBinanceTopN(200);                 // Binance USDT top200
    case "okx_top200":     return await fetchOKXTopN(200);                     // OKX USDT top200
    case "bitkub":    return await fetchBitkubTHB();                           // ทุกคู่ THB_
    case "set50":     return await fetchSETWikipedia("set50");                 // 50
    case "set100":    return await fetchSETWikipedia("set100");                // 100
    case "etfs":      return ["ARKK","DIA","EEM","IVV","IWM","JEPQ","MSTY","O","QQQ","SCHD","SPY","VNQ","GLD","SLV","XLE","XLK","XLF","XLV","XLY","IEMG","VTI","VOO"];
    case "gold":      return ["GC=F","XAUUSD=X"];
    default:          return [];
  }
}

// S&P500: slickcharts (ครบ 500)
async function fetchSP500Slickcharts() {
  const url = "https://www.slickcharts.com/sp500";
  const html = await (await fetch(url, { headers: UA_HEADERS })).text();
  // สัญลักษณ์อยู่คอลัมน์ Symbol ทั้ง 500 บรรทัด
  const re = /<td class="text-center">([A-Z.\-]{1,7})<\/td>/g;
  const out = new Set();
  let m; while((m=re.exec(html))) out.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(out);
  if (arr.length < 400) throw new Error("slickcharts parse too small");
  return arr.slice(0,500);
}

// Nasdaq100: Wikipedia
async function fetchNasdaq100Wikipedia() {
  const url = "https://en.wikipedia.org/wiki/Nasdaq-100";
  const html = await (await fetch(url, { headers: UA_HEADERS })).text();
  const set = new Set();
  const re = />\s*([A-Z.\-]{1,7})\s*<\/a>\s*<\/td>/g;
  let m; while((m=re.exec(html))) set.add(m[1].toUpperCase().replace(/\./g,"-"));
  const arr = Array.from(set).filter(x=>/^[A-Z\-]+$/.test(x));
  if (arr.length < 80) throw new Error("nas100 parse small");
  return arr.slice(0,100);
}

// SET50/SET100: Wikipedia
async function fetchSETWikipedia(which) {
  const page = which === "set50" ? "SET50_Index" : "SET100_Index";
  const url = `https://en.wikipedia.org/wiki/${page}`;
  const html = await (await fetch(url, { headers: UA_HEADERS })).text();
  const set = new Set();
  const re = />([A-Z0-9]{2,6})<\/a><\/td>/g;
  let m; while((m=re.exec(html))) set.add(m[1].toUpperCase());
  let arr = Array.from(set).filter(x => /^[A-Z]{2,6}$/.test(x));
  if (which==="set50" && arr.length<40) throw new Error("set50 parse small");
  if (which==="set100"&& arr.length<80) throw new Error("set100 parse small");
  return arr.slice(0, which==="set50"?50:100).map(s=> `${s}.BK`);
}

// Bitkub: ทุกคู่ THB_ → แปลงเป็น COIN_THB
async function fetchBitkubTHB() {
  const url = "https://api.bitkub.com/api/market/symbols";
  const r = await fetch(url, { headers: UA_HEADERS });
  if (!r.ok) throw new Error(`bitkub ${r.status}`);
  const js = await r.json();
  const out=[];
  for (const it of js?.result||[]) {
    const raw = String(it.symbol||""); // THB_BTC
    const [fiat, coin] = raw.split("_");
    if (fiat==="THB" && coin) out.push(`${coin}_THB`);
  }
  return uniq(out).sort();
}

// OKX / Binance ranking
const STABLES = new Set(["USDT","USDC","DAI","TUSD","FDUSD","USDD","BUSD"]);
const EXCLUDE = new Set(["BTC","ETH"]);

async function fetchOKXTopN(n=200, altOnly=false){
  // OKX tickers – เอาเฉพาะ SPOT USDT คู่
  const url = "https://www.okx.com/api/v5/market/tickers?instType=SPOT";
  const js = await (await fetch(url, { headers: UA_HEADERS })).json();
  let rows = (js?.data||[])
    .filter(x => x.instId.endsWith("-USDT"))
    .map(x => ({
      sym: x.instId.replace("-",""),
      base: x.instId.split("-")[0],
      vol: Number(x.vol24h||0)
    }));
  if (altOnly) rows = rows.filter(r => !STABLES.has(r.base) && !EXCLUDE.has(r.base));
  rows.sort((a,b)=> b.vol - a.vol);
  return rows.slice(0,n).map(r=> r.sym);
}
async function fetchBinanceTopN(n=200){
  // 24hr ticker – sort ด้วย quoteVolume – เอาเฉพาะ ...USDT
  const url = "https://api.binance.com/api/v3/ticker/24hr";
  const js = await (await fetch(url, { headers: UA_HEADERS })).json();
  const rows = js
    .filter(x => x.symbol.endsWith("USDT"))
    .map(x => ({ sym: x.symbol, vol: Number(x.quoteVolume||0) }))
    .sort((a,b)=> b.vol - a.vol)
    .slice(0,n)
    .map(r => r.sym);
  return rows;
}

/* =============================== OHLC FETCH ============================ */
// คืน { ohlcD:[{t,o,h,l,c}], ohlcW:[...], lastPrice:number|null }
async function fetchCandlesAll(group, ticker) {
  // route ตามประเภท
  if (group==="bitkub") {
    // Bitkub uses tradingview/history (unofficial) – 1D & 1W
    const sym = `THB_${ticker.split("_")[0]}`; // COIN_THB -> THB_COIN
    const [d, w] = await Promise.all([
      fetchBitkubOHLC(sym, "1D"),
      fetchBitkubOHLC(sym, "1W")
    ]);
    const last = d && d.length ? d[d.length-1].c : null;
    return { ohlcD: d, ohlcW: w, lastPrice: last };
  }

  if (ticker.endsWith(".BK") || /^[A-Z.=]+$/.test(ticker)) {
    // หุ้น/ETF → Yahoo Finance
    const ysym = ticker; // SET เติม .BK แล้วด้านบน
    const [d, w] = await Promise.all([
      fetchYahoo(ysym, "1d"),
      fetchYahoo(ysym, "1wk")
    ]);
    const last = d && d.length ? d[d.length-1].c : null;
    return { ohlcD: d, ohlcW: w, lastPrice: last };
  }

  // คริปโต – ลอง Binance ก่อน ถ้าไม่เจอใช้ OKX
  const [dB, wB] = await Promise.all([
    fetchBinanceKlines(ticker, "1d").catch(()=>null),
    fetchBinanceKlines(ticker, "1w").catch(()=>null)
  ]);
  if (dB && dB.length) {
    const last = dB[dB.length-1].c;
    return { ohlcD: dB, ohlcW: wB||[], lastPrice: last };
  }
  const okxId = ticker.replace(/USDT$/,"-USDT");
  const [dO, wO] = await Promise.all([
    fetchOKXCandles(okxId, "1D").catch(()=>null),
    fetchOKXCandles(okxId, "1W").catch(()=>null)
  ]);
  const last = dO && dO.length ? dO[dO.length-1].c : null;
  return { ohlcD: dO||[], ohlcW: wO||[], lastPrice: last };
}

// Bitkub tradingview
async function fetchBitkubOHLC(symbol, tf) {
  // tf: 1D / 1W -> resolution: "1D"|"1W"
  const now = Math.floor(Date.now()/1000);
  const from = now - 400*24*3600;
  const url = `https://api.bitkub.com/tradingview/history?symbol=${symbol}&resolution=${tf}&from=${from}&to=${now}`;
  const js = await (await fetch(url, { headers: UA_HEADERS })).json();
  if (!js || js.s!=="ok") return [];
  const out=[];
  for (let i=0;i<js.t.length;i++){
    out.push({ t: js.t[i]*1000, o:+js.o[i], h:+js.h[i], l:+js.l[i], c:+js.c[i] });
  }
  return out;
}

// Yahoo Finance
async function fetchYahoo(symbol, interval="1d", range="2y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const js = await (await fetch(url, { headers: UA_HEADERS })).json();
  const r = js?.chart?.result?.[0];
  if (!r) return [];
  const t = r.timestamp || [];
  const o = r.indicators?.quote?.[0]?.open  || [];
  const h = r.indicators?.quote?.[0]?.high  || [];
  const l = r.indicators?.quote?.[0]?.low   || [];
  const c = r.indicators?.quote?.[0]?.close || [];
  const out=[];
  for (let i=0;i<t.length;i++){
    if (o[i]==null || c[i]==null) continue;
    out.push({ t: t[i]*1000, o:+o[i], h:+h[i], l:+l[i], c:+c[i] });
  }
  return out;
}

// Binance klines
async function fetchBinanceKlines(symbol, interval="1d") {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=500`;
  const js = await (await fetch(url, { headers: UA_HEADERS })).json();
  if (!Array.isArray(js)) throw new Error("binance klines failed");
  return js.map(x => ({ t:x[0], o:+x[1], h:+x[2], l:+x[3], c:+x[4] }));
}

// OKX candles
async function fetchOKXCandles(instId, bar="1D") {
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=500`;
  const js = await (await fetch(url, { headers: UA_HEADERS })).json();
  if (!Array.isArray(js?.data)) throw new Error("okx candles failed");
  const rows = js.data.map(x => ({ t:+x[0], o:+x[1], h:+x[2], l:+x[3], c:+x[4] }));
  rows.sort((a,b)=> a.t-b.t);
  return rows;
}

/* ================================ GITHUB I/O =============================== */
async function ghReadJSON(path, repo, branch) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op: "read", path, repo: repo||"", branch: branch||"" }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ghRead ${r.status} ${await r.text()}`);
  return r.json();
}
async function ghWrite(path, repo, branch, content, message) {
  const base = process.env.NEXT_PUBLIC_API_BASE || "";
  const qs = new URLSearchParams({ op: "write", path, repo: repo||"", branch: branch||"" }).toString();
  const url = `${base}/api/github?${qs}`;
  const r = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ content, message })
  });
  if (!r.ok) throw new Error(`ghWrite ${r.status} ${await r.text()}`);
  return r.json();
}

/**
 * mergeAndWriteSignals:
 *  - โหลด signals.json เดิม
 *  - ถ้า group เดิม → รวมผลโดย key = ticker (ข้อมูลใหม่ทับของเก่า)
 *  - เขียนกลับ พร้อม updatedAt ใหม่
 */
async function mergeAndWriteSignals(payload) {
  const repo   = process.env.GH_REPO || process.env.GH_REPO_SYMBOLS;
  const branch = process.env.GH_BRANCH || "main";
  const path   = process.env.GH_PATH_SIGNALS || "data/signals.json";

  let prev = {};
  try { prev = await ghReadJSON(path, repo, branch); } catch {}

  let map = new Map();
  if (prev?.group === payload.group && Array.isArray(prev?.results)) {
    for (const r of prev.results) map.set(r.ticker, r);
  }
  for (const r of payload.results) map.set(r.ticker, r);

  const merged = { group: payload.group, updatedAt: payload.updatedAt, results: Array.from(map.values()) };
  await ghWrite(path, repo, branch, JSON.stringify(merged,null,2), `update signals ${payload.group}`);
  return merged;
}

/* ================================== UTILS ================================= */
const uniq = arr => Array.from(new Set((arr||[]).map(s => String(s||"").trim()).filter(Boolean)));
const round2 = n => Math.round(n*100)/100;
