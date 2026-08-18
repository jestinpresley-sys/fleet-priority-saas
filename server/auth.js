const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const {
  getUserByEmail, getUserById, createUser, updateUser,
  createSession, getSession, listSessionsForUser, touchSession,
  deleteSession, deleteSessionsForUserExcept,
} = require('./db');
const { sendPasswordResetEmail } = require('./mailer');

const COOKIE_NAME = 'fp_session';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function jwtSecret() {
  return process.env.JWT_SECRET || 'insecure-dev-secret-change-me';
}

// Every login mints its own session record, and the JWT carries that
// session's id — that's what lets a single device be signed out
// individually later ("linked devices"), rather than only being able to
// invalidate every token for a user at once.
function signToken(userId, sessionId) {
  return jwt.sign({ userId, sessionId }, jwtSecret(), { expiresIn: '7d' });
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function startSession(res, user, req) {
  const session = createSession(user.id, req.headers['user-agent'] || '');
  setSessionCookie(res, signToken(user.id, session.id));
  return session;
}

function requireAuth(req, res, next) {
  const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const payload = jwt.verify(token, jwtSecret());
    const user = getUserById(payload.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    const session = getSession(payload.sessionId);
    if (!session || session.userId !== user.id) {
      return res.status(401).json({ error: 'This session has been signed out.' });
    }
    touchSession(session.id);
    req.user = user;
    req.sessionId = session.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
}

// Rough, dependency-free device label for the "linked devices" list — good
// enough to tell your devices apart, not meant to be a precise UA parse.
function describeUserAgent(ua) {
  ua = ua || '';
  let os = 'Unknown device';
  if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/iPad/i.test(ua)) os = 'iPad';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Mac OS X/i.test(ua)) os = 'Mac';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/CriOS/i.test(ua) || (/Chrome\//i.test(ua) && !/Chromium/i.test(ua))) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) browser = 'Safari';

  return browser ? `${browser} on ${os}` : os;
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
    name: user.name || '',
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
  startSession(res, user, req);
  res.status(201).json({ user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = getUserByEmail(String(email || '').trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });
  startSession(res, user, req);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  if (token) {
    try {
      const payload = jwt.verify(token, jwtSecret());
      deleteSession(payload.sessionId);
    } catch (e) { /* token already invalid/expired — nothing to revoke */ }
  }
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.put('/profile', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (name !== undefined && typeof name !== 'string') {
    return res.status(400).json({ error: 'Name must be text.' });
  }
  const trimmed = (name || '').trim();
  if (trimmed.length > 100) {
    return res.status(400).json({ error: 'Name must be 100 characters or fewer.' });
  }
  const updated = updateUser(req.user.id, { name: trimmed });
  res.json({ user: publicUser(updated) });
});

router.put('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  const ok = await bcrypt.compare(String(currentPassword), req.user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const passwordHash = await bcrypt.hash(String(newPassword), 10);
  updateUser(req.user.id, { passwordHash });
  // Changing your password signs out every other device — standard
  // practice, and it doubles as recovery if a session was compromised.
  deleteSessionsForUserExcept(req.user.id, req.sessionId);
  res.json({ ok: true });
});

router.get('/sessions', requireAuth, (req, res) => {
  const sessions = listSessionsForUser(req.user.id)
    .slice()
    .sort((a, b) => (b.lastSeenAt || '').localeCompare(a.lastSeenAt || ''))
    .map((s) => ({
      id: s.id,
      device: describeUserAgent(s.userAgent),
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      isCurrent: s.id === req.sessionId,
    }));
  res.json({ sessions });
});

// Bulk revoke — "log out other devices". Declared before /sessions/:id
// only for readability; Express doesn't need the ordering since the paths
// don't overlap.
router.delete('/sessions', requireAuth, (req, res) => {
  deleteSessionsForUserExcept(req.user.id, req.sessionId);
  res.json({ ok: true });
});

router.delete('/sessions/:id', requireAuth, (req, res) => {
  const session = getSession(req.params.id);
  if (!session || session.userId !== req.user.id) {
    return res.status(404).json({ error: 'Session not found.' });
  }
  deleteSession(req.params.id);
  res.json({ ok: true });
});

router.post('/forgot-password', async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const user = email ? getUserByEmail(email) : null;
  // Always respond the same way whether or not the email exists — otherwise
  // this endpoint becomes a way to check who has an account.
  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    updateUser(user.id, {
      resetTokenHash: hashResetToken(rawToken),
      resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
    });
    const resetUrl = `${APP_URL}/reset-password.html?email=${encodeURIComponent(user.email)}&token=${rawToken}`;
    sendPasswordResetEmail(user.email, resetUrl).catch((err) => {
      console.error('sendPasswordResetEmail failed:', err.message);
    });
  }
  res.json({ ok: true });
});

router.post('/reset-password', async (req, res) => {
  const { email, token, newPassword } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = normalizedEmail ? getUserByEmail(normalizedEmail) : null;
  const genericError = { error: 'This reset link is invalid or has expired.' };
  if (!user || !user.resetTokenHash || !token) {
    return res.status(400).json(genericError);
  }
  const expiresAt = user.resetTokenExpiresAt ? new Date(user.resetTokenExpiresAt).getTime() : 0;
  if (!expiresAt || Date.now() > expiresAt) {
    return res.status(400).json(genericError);
  }
  const providedHash = hashResetToken(String(token));
  const matches = providedHash.length === user.resetTokenHash.length
    && crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(user.resetTokenHash));
  if (!matches) {
    return res.status(400).json(genericError);
  }
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const passwordHash = await bcrypt.hash(String(newPassword), 10);
  updateUser(user.id, { passwordHash, resetTokenHash: null, resetTokenExpiresAt: null });
  // A password reset means the account may have been at risk — sign out
  // everywhere, including whatever session (if any) is making this request.
  deleteSessionsForUserExcept(user.id, null);
  startSession(res, user, req);
  res.json({ user: publicUser(user) });
});

module.exports = { router, requireAuth, requireActiveSub, publicUser };
