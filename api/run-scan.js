// api/run-scan.js
import { writeJsonFile, PATHS, withCors } from "./_github";

const GROUPS = {
  sp500:     ["AAPL","MSFT","NVDA","GOOGL","AMZN","META","AVGO","TSLA","BRK.B","LLY"],
  nasdaq100: ["AAPL","MSFT","NVDA","GOOGL","AMZN","META","PEP","COST","ADBE","NFLX"],
  etf:       ["SPY","QQQ","ARKK","VTI","DIA","IWM","XLK","XLF","XLV","SMH"],
  altcoins:  ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT","AVAXUSDT","DOTUSDT"],
  binance:   ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","DOGEUSDT","TONUSDT","ADAUSDT"],
  okx:       ["BTC-USDT","ETH-USDT","SOL-USDT","XRP-USDT","ADA-USDT"],
  bitkub:    ["BTC_THB","ETH_THB","USDT_THB","BNB_THB","ARB_THB"],
  set50:     ["SET:PTT","SET:CPALL","SET:ADVANC","SET:SCB","SET:BBL"],
  set100:    ["SET:PTT","SET:CPALL","SET:ADVANC","SET:SCB","SET:BBL","SET:BDMS"],
  gold:      ["XAUUSD","GOLD"], // เผื่ออนาคต
};

// mock indicator — ตรงนี้คือ “จุดเสียบ” ของอินดิเคเตอร์จริงของคุณ
function mockSignalFor(ticker) {
  const r = Math.random();
  const sig = r > 0.8 ? "Strong Buy" : r > 0.6 ? "Buy" : r < 0.1 ? "Strong Sell" : r < 0.25 ? "Sell" : "Neutral";
  const price = (100 + Math.random() * 2000).toFixed(2);
  const tf    = ["15m","1H","4H","1D","1W"][Math.floor(Math.random()*5)];
  return { ticker, signal: sig, price, timeframe: tf };
}

// ตรงนี้ “ควร” เชื่อมต่อ source จริง (TradingView/Binance/ฯลฯ) แล้วคำนวณอินดิเคเตอร์ของคุณ
async function scanGroup(group) {
  const list = GROUPS[group] || [];
  // TODO: แทนที่ส่วน mock ข้างล่างด้วย real scanner ของคุณ
  const picks = list
    .map(t => mockSignalFor(t))
    .filter(x => x.signal === "Strong Buy" || x.signal === "Buy")   // เผยเฉพาะที่เข้าเงื่อนไข
    .slice(0, 20);
  return picks;
}

export default async function handler(req, res) {
  withCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const group = String(req.query.group || "").toLowerCase().trim();
    if (!group) return res.status(400).json({ error: "missing group" });

    const signals = await scanGroup(group);
    const payload = {
      last_updated: new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }),
      scan_group: group,
      signals_found: signals,
    };
    await writeJsonFile(PATHS.GH_PATH_SIGNALS, payload, `scan ${group}`);

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
