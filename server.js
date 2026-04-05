const express = require('express');
const cors    = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');


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

// ── בריאות ────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Eden server on port ${PORT}`));
