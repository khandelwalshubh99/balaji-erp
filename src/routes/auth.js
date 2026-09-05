import { Router } from 'express';
import { db } from '../db/index.js';
import { verifyPassword } from '../lib/password.js';

export const authRouter = Router();

authRouter.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  req.session.user = { id: user.id, username: user.username, name: user.display_name, role: user.role };
  res.json({ user: req.session.user });
});

authRouter.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

authRouter.get('/api/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: req.session.user });
});
