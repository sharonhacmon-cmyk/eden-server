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

function getSimPricesForDate(dateObj) {
  const seed = dateObj.getFullYear()*10000 + (dateObj.getMonth()+1)*100 + dateObj.getDate();
  const out  = {};
  Object.entries(BASE_PRICES).forEach(([sym, base], i) => {
    const pct   = (seededRand(seed*100 + i) - 0.45) * 4.2;
    const price = Math.round(base * (1 + pct/100) * 100) / 100;
    const chg   = Math.round((price - base) * 100) / 100;
    out[sym] = { price, change: chg, changePercent: Math.round(pct*100)/100,
                 name: STOCK_NAMES[sym] || sym };
  });
  return out;
}

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
  syncTradingDataToGitHub(data); // persist across deploys (non-blocking)
}

// ── GitHub persistence (trading_data.json survives Render deploys) ──────────
const GH_TOKEN = process.env.GITHUB_TOKEN; // set in Render dashboard → Environment
const GH_OWNER = 'sharonhacmon-cmyk';
const GH_REPO  = 'eden-server';
const GH_PATH  = 'trading_data.json';
const GH_CONTACTS_PATH = 'contacts.json';

async function ghSyncFile(filePath, data, commitMsg) {
  if (!GH_TOKEN) { console.warn('GitHub sync skipped — GITHUB_TOKEN not set'); return; }
  try {
    const headers = {
      'Authorization': `token ${GH_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'EdenServer/1.0'
    };
    const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`;
    const getRes = await fetch(url, { headers });
    const current = getRes.ok ? await getRes.json() : {};
    const sha = current.sha; // undefined → creates new file
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const body = { message: commitMsg, content };
    if (sha) body.sha = sha;
    const putRes = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (!putRes.ok) {
      const err = await putRes.text();
      console.error(`GitHub sync failed [${filePath}]:`, err.slice(0, 200));
    } else {
      console.log(`GitHub sync OK [${filePath}]`);
    }
  } catch(e) {
    console.error(`GitHub sync error [${filePath}]:`, e.message);
  }
}

async function syncTradingDataToGitHub(data) {
  await ghSyncFile(GH_PATH, data, 'sync: update trading data');
}

// טעינת נתונים מ-GitHub בהפעלת השרת (Render מוחק את הקבצים בכל deploy)
async function loadTradingDataFromGitHub() {
  if (!GH_TOKEN) return;
  try {
    const headers = {
      'Authorization': `token ${GH_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'EdenServer/1.0'
    };
    const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`;
    const res = await fetch(url, { headers });
    if (!res.ok) { console.log('No trading data on GitHub yet'); return; }
    const json = await res.json();
    const decoded = Buffer.from(json.content, 'base64').toString('utf8');
    const data = JSON.parse(decoded);
    if (Object.keys(data).length > 0) {
      fs.writeFileSync(TRADING_FILE, JSON.stringify(data, null, 2), 'utf8');
      console.log(`Loaded trading data from GitHub: ${Object.keys(data).length} players`);
    }
  } catch(e) {
    console.error('Failed to load trading data from GitHub:', e.message);
  }
}

async function loadContactsFromGitHub() {
  if (!GH_TOKEN) return;
  try {
    const headers = {
      'Authorization': `token ${GH_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'EdenServer/1.0'
    };
    const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_CONTACTS_PATH}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return;
    const json = await res.json();
    const decoded = Buffer.from(json.content, 'base64').toString('utf8');
    const data = JSON.parse(decoded);
    if (data.length > 0) {
      fs.writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2), 'utf8');
      console.log(`Loaded contacts from GitHub: ${data.length} contacts`);
    }
  } catch(e) {
    console.error('Failed to load contacts from GitHub:', e.message);
  }
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
  const { name, gender, language } = req.body;
  if (!name || !gender) return res.status(400).json({ error: 'חסרים פרטים' });
  const data = loadTradingData();
  const code = req.playerCode;
  if (!data[code]) {
    data[code] = {
      name: name.trim(), gender,
      language: language || 'he',
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

// ── שער חליפין דולר/שקל (בנק ישראל) ─────────────────
let fxCache = { rate: 3.70, date: null };

app.get('/api/fxrate', async (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  if (fxCache.date === today) return res.json({ rate: fxCache.rate, date: fxCache.date, source: 'cache' });
  try {
    // Bank of Israel public API — returns array with currentExchangeRate per currency
    const url = 'https://www.boi.org.il/PublicApi/GetExchangeRates?asXml=false';
    const r   = await fetch(url, { signal: AbortSignal.timeout(6000),
      headers: { 'Accept': 'application/json', 'User-Agent': 'EdenFinance/1.0' } });
    const arr = await r.json();
    const usd = Array.isArray(arr) && arr.find(x => x.key === 'USD');
    if (usd && usd.currentExchangeRate > 0) {
      const rate = usd.currentExchangeRate;
      const date = usd.lastUpdate ? usd.lastUpdate.slice(0,10) : today;
      fxCache = { rate, date };
      return res.json({ rate, date, source: 'boi' });
    }
    res.json({ rate: fxCache.rate, date: fxCache.date || today, source: 'fallback' });
  } catch(e) {
    res.json({ rate: fxCache.rate, date: fxCache.date || today, source: 'fallback' });
  }
});

// היסטוריית מחירים — 30 יום אחורה (מחושב מה-seed, ללא שמירה)
app.get('/api/history/:symbol', (req, res) => {
  const sym  = req.params.symbol.toUpperCase();
  if (!BASE_PRICES[sym]) return res.status(404).json({ error: 'לא נמצא' });
  const days = parseInt(req.query.days) || 30;
  const history = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    // skip weekends
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const prices = getSimPricesForDate(d);
    const p = prices[sym];
    const label = d.toLocaleDateString('he-IL', { month:'short', day:'numeric' });
    history.push({ date: label, price: p.price, changePercent: p.changePercent });
  }
  res.json(history);
});

// All stock prices
app.get('/api/stocks', async (req, res) => {
  try {
    const results = await yahooQuoteBulk(TRADEABLE_STOCKS);
    const prices = {};
    results.forEach(q => {
      prices[q.symbol] = {
        price:         q.price,
        change:        q.change,
        changePercent: q.changePercent,
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

// ── ותק וקטגוריה ──────────────────────────────────
function getVetek(setupAt) {
  const days = Math.floor((Date.now() - new Date(setupAt).getTime()) / 86400000);
  if (days <= 30)  return { days, tier: 'junior',  label: '🌱 משקיע צעיר' };
  if (days <= 90)  return { days, tier: 'active',  label: '📊 משקיע פעיל' };
  return             { days, tier: 'veteran', label: '🏦 משקיע ותיק' };
}

// Leaderboard — מחזיר רק את הקטגוריה של השחקן המחובר
app.get('/api/trading/leaderboard', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: 'לא מחובר' });
  const myCode = session.code.toUpperCase();

  try {
    const data = loadTradingData();
    const myPlayer = data[myCode];
    const myTier = myPlayer ? getVetek(myPlayer.setupAt).tier : 'junior';

    const allSymbols = new Set();
    Object.values(data).forEach(p => Object.keys(p.portfolio || {}).forEach(s => allSymbols.add(s)));
    const prices = {};
    if (allSymbols.size > 0) {
      const bulk = await yahooQuoteBulk([...allSymbols]).catch(() => []);
      bulk.forEach(q => { prices[q.symbol] = q.regularMarketPrice; });
    }

    const ranked = Object.entries(data)
      .filter(([, p]) => p.setupAt && getVetek(p.setupAt).tier === myTier)
      .map(([code, p]) => {
        let pv = 0;
        Object.entries(p.portfolio || {}).forEach(([sym, h]) => { pv += (prices[sym] || h.avgPrice) * h.shares; });
        const total = p.cash + pv;
        const profit = total - STARTING_CASH;
        const vetek = getVetek(p.setupAt);
        return {
          name: p.name, gender: p.gender, total, cash: p.cash, portfolioValue: pv,
          profit, profitPct: (profit/STARTING_CASH*100).toFixed(1),
          trades: (p.trades||[]).length,
          tier: vetek.tier, tierLabel: vetek.label, days: vetek.days,
          isMe: code === myCode
        };
      })
      .sort((a, b) => parseFloat(b.profitPct) - parseFloat(a.profitPct));

    const tierLabel = myPlayer ? getVetek(myPlayer.setupAt).label : '🌱 משקיע צעיר';
    res.json({ players: ranked, tierLabel });
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

// ══════════════════════════════════════════════════
// ── CONTACT LEADS ─────────────────────────────────
// ══════════════════════════════════════════════════

const CONTACTS_FILE = path.join(__dirname, 'contacts.json');

function loadContacts() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); }
  catch { return []; }
}
function saveContacts(data) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2), 'utf8');
  syncContactsToGitHub(data);
}

async function syncContactsToGitHub(data) {
  await ghSyncFile(GH_CONTACTS_PATH, data, 'sync: update contacts');
}

// שמירת פנייה חדשה (ציבורי)
app.post('/api/contact', (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || (!email && !phone)) {
    return res.status(400).json({ error: 'נא למלא שם ולפחות אחד מאמצעי הקשר' });
  }
  const contacts = loadContacts();
  contacts.push({ id: Date.now(), name, email: email || '', phone: phone || '', createdAt: new Date().toISOString() });
  saveContacts(contacts);
  res.json({ ok: true });
});

// צפייה בפניות (מוגן)
app.get('/admin/contacts', adminAuth, (req, res) => {
  res.json(loadContacts());
});

// מחיקת פנייה
app.delete('/admin/contacts/:id', adminAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const contacts = loadContacts().filter(c => c.id !== id);
  saveContacts(contacts);
  res.json({ ok: true });
});

// ── בריאות ────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ── הפעלת השרת — טעינה מ-GitHub לפני ה-listen ──────
const PORT = process.env.PORT || 3001;
Promise.all([loadTradingDataFromGitHub(), loadContactsFromGitHub()])
  .then(() => {
    app.listen(PORT, () => console.log(`Eden server on port ${PORT}`));
  })
  .catch(() => {
    app.listen(PORT, () => console.log(`Eden server on port ${PORT}`));
  });
