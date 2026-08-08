const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getUserByEmail, getUserById, createUser } = require('./db');

const COOKIE_NAME = 'fp_session';

function jwtSecret() {
  return process.env.JWT_SECRET || 'insecure-dev-secret-change-me';
}

function signToken(userId) {
  return jwt.sign({ userId }, jwtSecret(), { expiresIn: '7d' });
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const payload = jwt.verify(token, jwtSecret());
    const user = getUserById(payload.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
}

function requireActiveSub(req, res, next) {
  const status = req.user.subscriptionStatus;
  if (status === 'active' || status === 'trialing') return next();
  return res.status(402).json({ error: 'An active subscription is required.', code: 'SUBSCRIPTION_REQUIRED' });
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan || null,
    subscriptionStatus: user.subscriptionStatus || 'inactive',
    hasBillingAccount: !!user.stripeCustomerId,
  };
}

const router = express.Router();

router.post('/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (getUserByEmail(normalizedEmail)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = createUser({ email: normalizedEmail, passwordHash });
  setSessionCookie(res, signToken(user.id));
  res.status(201).json({ user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = getUserByEmail(String(email || '').trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });
  setSessionCookie(res, signToken(user.id));
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = { router, requireAuth, requireActiveSub, publicUser };
