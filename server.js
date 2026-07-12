const express = require('express');
const cors    = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');


const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── סיסמאות ──────────────────────────────────────
function loadPasswords() {
  const file = path.join(__dirname, 'passwords.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── סשנים (זיכרון — מספיק לפיילוט) ──────────────
const sessions = new Map();

// ── כניסה ─────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'חסרה סיסמה' });

  const passwords = loadPasswords();
  const entry = passwords.find(p =>
    p.code.toUpperCase() === password.toUpperCase() && p.active
  );

  if (!entry) return res.status(401).json({ error: 'סיסמה שגויה — נסי שוב או צרי קשר עם שרון' });

  if (entry.expires && new Date(entry.expires) < new Date()) {
    return res.status(401).json({ error: 'הגישה שלך פגה. צרי קשר עם שרון לחידוש' });
  }

  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessions.set(token, { ...entry, loginAt: Date.now() });

  res.json({ token, name: entry.name });
});

// ── צ'אט ──────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'לא מחוברת — נסי לרענן את הדף' });
  }

  const { messages, system } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'בקשה לא תקינה' });
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: system || '',
      messages
    });
    res.json({ content: response.content[0].text });
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.status(500).json({ error: 'שגיאה בחיבור לעדן — נסי שוב' });
  }
});

// ── ניהול (מוגן בסיסמת אדמין) ─────────────────────
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'sharon-admin';

function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASS) return res.status(401).json({ error: 'לא מורשה' });
  next();
}

function savePasswords(data) {
  const file = path.join(__dirname, 'passwords.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// רשימת קודים
app.get('/admin/users', adminAuth, (req, res) => {
  res.json(loadPasswords());
});

// הוספת קוד
app.post('/admin/users', adminAuth, (req, res) => {
  const { code, name, expires } = req.body;
  if (!code || !name || !expires) return res.status(400).json({ error: 'חסרים פרטים' });
  const list = loadPasswords();
  if (list.find(p => p.code.toUpperCase() === code.toUpperCase())) {
    return res.status(400).json({ error: 'קוד כבר קיים' });
  }
  list.push({ code: code.toUpperCase(), name, expires, active: true });
  savePasswords(list);
  res.json({ ok: true });
});

// מחיקת קוד
app.delete('/admin/users/:code', adminAuth, (req, res) => {
  const list = loadPasswords().filter(p => p.code.toUpperCase() !== req.params.code.toUpperCase());
  savePasswords(list);
  res.json({ ok: true });
});

// ── עדכון קרנות ───────────────────────────────────
let fundsUpdateRunning = false;

app.post('/admin/update-funds', adminAuth, (req, res) => {
  if (fundsUpdateRunning) {
    return res.json({ ok: false, message: 'עדכון כבר רץ, המתיני...' });
  }
  fundsUpdateRunning = true;
  const script = path.join(__dirname, 'fetch_funds.py');
  const proc = spawn('python', [script], { cwd: __dirname });

  let output = '';
  proc.stdout.on('data', d => { output += d.toString(); });
  proc.stderr.on('data', d => { output += d.toString(); });

  proc.on('close', code => {
    fundsUpdateRunning = false;
    res.json({ ok: code === 0, message: output.slice(-500) });
  });

  proc.on('error', err => {
    fundsUpdateRunning = false;
    res.json({ ok: false, message: err.message });
  });
});

app.get('/admin/funds-status', adminAuth, (req, res) => {
  const file = path.join(__dirname, 'public', 'eden_funds.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    res.json({ ok: true, last_updated: data.last_updated, running: fundsUpdateRunning });
  } catch {
    res.json({ ok: false, last_updated: null, running: fundsUpdateRunning });
  }
});

// ══════════════════════════════════════════════════
// ── TRADING GAME ──────────────────────────────────
// ══════════════════════════════════════════════════

// ── מחירי מניות — מדומים ריאליסטיים, מתעדכנים יומית ──
// מחירי בסיס בשקלים — שע"ח 3.70 ₪ לדולר (עדכון ידני אחת לחודש)
const BASE_PRICES = {
  // ישראלי
  'CHKP':521,'WIX':659,'MNDY':955,'TEVA':68,'GLBE':200,'NICE':740,'CYBR':1036,
  // מניות ארה"ב
  'AAPL':773,'MSFT':1576,'NVDA':503,'TSLA':1029,'META':2042,'AMZN':722,'GOOGL':677,
  'NFLX':2331,'DIS':389,'AMD':592,'KO':241,'NKE':278,'JPM':833,
  // תעודות סל
  'SPY':1983,'QQQ':1706,'VTI':999,'GLD':888,'XLK':814,'XLE':299,
  // אג"ח
  'TLT':333,'AGG':359,'HYG':277,
  // נדל"ן
  'VNQ':333,
  // סחורות
  'USO':74,'SLV':82
};
const STOCK_NAMES = {
  'CHKP':'Check Point Software','WIX':'Wix.com','MNDY':'Monday.com',
  'TEVA':'Teva Pharmaceutical','GLBE':'Global-E Online',
  'SPY':'SPDR S&P 500 ETF','QQQ':'Invesco QQQ Trust',
  'AAPL':'Apple Inc.','MSFT':'Microsoft Corp.','NVDA':'NVIDIA Corp.',
  'TSLA':'Tesla Inc.','META':'Meta Platforms','AMZN':'Amazon.com','GOOGL':'Alphabet Inc.'
};

// מספר אקראי דטרמיניסטי לפי seed (אותם מחירים לכולם ביום נתון)
function seededRand(n) { let x = Math.sin(n+1)*10000; return x - Math.floor(x); }

function getSimPrices() {
  const d = new Date();
  const seed = d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate();
  const out  = {};
  Object.entries(BASE_PRICES).forEach(([sym, base], i) => {
    const pct   = (seededRand(seed*100 + i) - 0.45) * 4.2; // -1.9% עד +2.3%
    const price = Math.round(base * (1 + pct/100) * 100) / 100;
    const chg   = Math.round((price - base) * 100) / 100;
    out[sym] = { price, change: chg, changePercent: Math.round(pct*100)/100,
                 name: STOCK_NAMES[sym] || sym };
  });
  return out;
}

function yahooQuote(symbol) {
  const p = getSimPrices()[symbol];
  if (!p) throw new Error('Unknown symbol: ' + symbol);
  return Promise.resolve({
    regularMarketPrice:         p.price,
    regularMarketChange:        p.change,
    regularMarketChangePercent: p.changePercent,
    longName: p.name,
  });
}
function yahooQuoteBulk(symbols) {
  return Promise.resolve(symbols.map(s => ({ symbol:s, ...getSimPrices()[s] })).filter(q=>q.price));
}

const TRADING_FILE  = path.join(__dirname, 'trading_data.json');
const STARTING_CASH = 50000;

const TRADEABLE_STOCKS = [
  // ישראלי
  'CHKP','WIX','MNDY','TEVA','GLBE','NICE','CYBR',
  // מניות ארה"ב
  'AAPL','MSFT','NVDA','TSLA','META','AMZN','GOOGL','NFLX','DIS','AMD','KO','NKE','JPM',
  // תעודות סל
  'SPY','QQQ','VTI','GLD','XLK','XLE',
  // אג"ח
  'TLT','AGG','HYG',
  // נדל"ן
  'VNQ',
  // סחורות
  'USO','SLV'
];

function loadTradingData() {
  try { return JSON.parse(fs.readFileSync(TRADING_FILE, 'utf8')); }
  catch { return {}; }
}
function saveTradingData(data) {
  fs.writeFileSync(TRADING_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Middleware: auth by bearer token (uses existing sessions map)
function tradingAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: 'לא מחובר — נכנס מחדש' });
  req.session = session;
  req.playerCode = session.code.toUpperCase();
  next();
}

// Setup profile (first time after login)
app.post('/api/trading/setup', tradingAuth, (req, res) => {
  const { name, gender, age, language } = req.body;
  if (!name || !gender || !age) return res.status(400).json({ error: 'חסרים פרטים' });
  const data = loadTradingData();
  const code = req.playerCode;
  if (!data[code]) {
    data[code] = {
      name: name.trim(), gender,
      age: parseInt(age), language: language || 'he',
      cash: STARTING_CASH, portfolio: {}, trades: [],
      setupAt: new Date().toISOString()
    };
    saveTradingData(data);
  }
  res.json({ ok: true, player: data[code] });
});

// Get my profile
app.get('/api/trading/me', tradingAuth, (req, res) => {
  const data = loadTradingData();
  const player = data[req.playerCode];
  if (!player) return res.json({ needsSetup: true });
  res.json(player);
});

// All stock prices
app.get('/api/stocks', async (req, res) => {
  try {
    const results = await yahooQuoteBulk(TRADEABLE_STOCKS);
    const prices = {};
    results.forEach(q => {
      prices[q.symbol] = {
        price:         q.regularMarketPrice,
        change:        q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        name:          q.longName || q.shortName || q.symbol,
      };
    });
    res.json(prices);
  } catch {
    res.status(500).json({ error: 'שגיאה בטעינת מחירים' });
  }
});

// Buy
app.post('/api/trading/buy', tradingAuth, async (req, res) => {
  const { symbol, shares } = req.body;
  const numShares = parseFloat(shares);
  const sym = (symbol || '').toUpperCase();
  if (!sym || !numShares || numShares <= 0 || !TRADEABLE_STOCKS.includes(sym)) {
    return res.status(400).json({ error: 'נתונים לא תקינים' });
  }
  try {
    const q    = await yahooQuote(sym);
    const price = q.regularMarketPrice;
    const total = price * numShares;
    const data  = loadTradingData();
    const player = data[req.playerCode];
    if (!player) return res.status(404).json({ error: 'פרופיל לא נמצא' });
    if (player.cash < total) {
      return res.status(400).json({ error: `אין מספיק כסף. נדרש: $${total.toFixed(0)}, יש: $${player.cash.toFixed(0)}` });
    }
    player.cash -= total;
    if (!player.portfolio[sym]) player.portfolio[sym] = { shares: 0, avgPrice: 0 };
    const h = player.portfolio[sym];
    h.avgPrice = (h.avgPrice * h.shares + price * numShares) / (h.shares + numShares);
    h.shares   = Math.round((h.shares + numShares) * 10000) / 10000;
    player.trades.unshift({ type:'buy', symbol:sym, shares:numShares, price, total, date: new Date().toISOString() });
    saveTradingData(data);
    res.json({ ok: true, cash: player.cash, portfolio: player.portfolio });
  } catch {
    res.status(500).json({ error: 'שגיאה — נסה שוב' });
  }
});

// Sell
app.post('/api/trading/sell', tradingAuth, async (req, res) => {
  const { symbol, shares } = req.body;
  const numShares = parseFloat(shares);
  const sym = (symbol || '').toUpperCase();
  const data = loadTradingData();
  const player = data[req.playerCode];
  if (!player) return res.status(404).json({ error: 'פרופיל לא נמצא' });
  const h = player.portfolio[sym];
  if (!h || h.shares < numShares - 0.0001) {
    return res.status(400).json({ error: 'אין מספיק מניות' });
  }
  try {
    const q    = await yahooQuote(sym);
    const price = q.regularMarketPrice;
    const total = price * numShares;
    player.cash += total;
    h.shares = Math.round((h.shares - numShares) * 10000) / 10000;
    if (h.shares < 0.001) delete player.portfolio[sym];
    player.trades.unshift({ type:'sell', symbol:sym, shares:numShares, price, total, date: new Date().toISOString() });
    saveTradingData(data);
    res.json({ ok: true, cash: player.cash, portfolio: player.portfolio });
  } catch {
    res.status(500).json({ error: 'שגיאה — נסה שוב' });
  }
});

// Leaderboard
app.get('/api/trading/leaderboard', async (req, res) => {
  try {
    const data = loadTradingData();
    const allSymbols = new Set();
    Object.values(data).forEach(p => Object.keys(p.portfolio || {}).forEach(s => allSymbols.add(s)));
    const prices = {};
    if (allSymbols.size > 0) {
      const bulk = await yahooQuoteBulk([...allSymbols]).catch(() => []);
      bulk.forEach(q => { prices[q.symbol] = q.regularMarketPrice; });
    }
    const ranked = Object.values(data).map(p => {
      let pv = 0;
      Object.entries(p.portfolio || {}).forEach(([sym, h]) => { pv += (prices[sym] || h.avgPrice) * h.shares; });
      const total = p.cash + pv;
      const profit = total - STARTING_CASH;
      return { name:p.name, gender:p.gender, total, cash:p.cash, portfolioValue:pv,
               profit, profitPct: (profit/STARTING_CASH*100).toFixed(1), trades:(p.trades||[]).length };
    }).sort((a,b) => b.total - a.total);
    res.json(ranked);
  } catch { res.status(500).json({ error: 'שגיאה' }); }
});

// Admin: all players
app.get('/admin/trading/all', adminAuth, (req, res) => {
  res.json(loadTradingData());
});

// Admin: reset player
app.post('/admin/trading/reset/:code', adminAuth, (req, res) => {
  const data = loadTradingData();
  const code = req.params.code.toUpperCase();
  if (!data[code]) return res.status(404).json({ error: 'לא נמצא' });
  data[code].cash = STARTING_CASH;
  data[code].portfolio = {};
  data[code].trades = [];
  saveTradingData(data);
  res.json({ ok: true });
});

// Admin: delete player
app.delete('/admin/trading/players/:code', adminAuth, (req, res) => {
  const data = loadTradingData();
  delete data[req.params.code.toUpperCase()];
  saveTradingData(data);
  res.json({ ok: true });
});

// ── בריאות ────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Eden server on port ${PORT}`));
