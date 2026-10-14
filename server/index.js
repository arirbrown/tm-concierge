require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Conversation, newSession } = require('./conversation');

for (const key of ['TICKETMASTER_API_KEY', 'ANTHROPIC_API_KEY']) {
  if (!process.env[key]) console.warn(`[concierge] Missing ${key}. Copy .env.example to .env and fill it in.`);
}

const app = express();
const sessions = new Map();
const conversation = new Conversation();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function cleanName(name) {
  const n = String(name || '').replace(/[^\p{L}\p{M}' -]/gu, '').trim().slice(0, 30);
  return n || 'Olivia';
}

function sessionFor(req, res) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
  let sid = cookies.sid;
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomUUID();
    sessions.set(sid, newSession(cleanName(req.body && req.body.name)));
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }
  return { sid, session: sessions.get(sid) };
}

function snapshot(s) {
  return { name: s.name, history: s.history, view: s.view, stage: s.stage };
}

app.post('/state', (req, res) => {
  const { session } = sessionFor(req, res);
  if (!session.history.length && req.body && req.body.name) {
    session.name = cleanName(req.body.name);
    session.view = { ...session.view, name: session.name };
  }
  res.json(snapshot(session));
});

app.post('/chat', async (req, res) => {
  const { session } = sessionFor(req, res);
  const { message, action, today } = req.body || {};
  const text = action && action.label ? action.label : message;
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Empty message' });
  session.history.push({ id: crypto.randomUUID(), role: 'user', text: String(text).slice(0, 1000) });
  const validToday = /^\d{4}-\d{2}-\d{2}$/.test(today || '') ? today : new Date().toISOString().slice(0, 10);
  const replies = await conversation.handle(session, { message: String(text).slice(0, 1000), action, today: validToday });
  res.json({ replies, view: session.view, stage: session.stage });
});

app.post('/reset', (req, res) => {
  const { sid, session } = sessionFor(req, res);
  const name = req.body && req.body.name ? cleanName(req.body.name) : session.name;
  sessions.set(sid, newSession(name));
  res.json(snapshot(sessions.get(sid)));
});

app.post('/feedback', (req, res) => {
  const { sid, session } = sessionFor(req, res);
  const { messageId, rating } = req.body || {};
  const msg = session.history.find((m) => m.id === messageId);
  if (!msg || !['up', 'down'].includes(rating)) return res.status(400).json({ error: 'Unknown message or rating' });
  console.log(`[feedback] ${rating === 'up' ? 'thumbs up' : 'thumbs down'} session=${sid.slice(0, 8)} stage=${session.stage} message="${msg.text}"`);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`[concierge] Listening on http://localhost:${PORT}`));
