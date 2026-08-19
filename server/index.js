require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { router: authRouter } = require('./auth');
const { router: billingRouter, webhookHandler } = require('./billing');
const fleetRouter = require('./fleet');
const { router: maintenanceRouter } = require('./maintenance');
const { router: inspectionsRouter } = require('./inspections');
const { router: notificationsRouter } = require('./notifications');
const { startReminderScheduler } = require('./reminders');

const REQUIRED_ENV = [
  'JWT_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_BASIC',
  'STRIPE_PRICE_PRO',
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(
    `\n⚠️  Missing environment variables: ${missing.join(', ')}.\n` +
    `   The server will start, but signup/login only will work until these are set.\n` +
    `   See .env.example.\n`
  );
}

const app = express();
app.set('trust proxy', 1);

// Stripe webhooks need the raw request body to verify the signature, so this
// route is registered BEFORE the global express.json() parser below.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), webhookHandler);

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRouter);
app.use('/api/billing', billingRouter);
app.use('/api/vehicles', fleetRouter);
app.use('/api/maintenance', maintenanceRouter);
app.use('/api/inspections', inspectionsRouter);
app.use('/api/notifications', notificationsRouter);

app.get('/', (req, res) => res.redirect('/login.html'));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// Central error handler — catches multer upload errors (bad file type, too large, etc.)
// and anything else thrown/passed via next(err) so API routes always get JSON back.
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be smaller than 5MB.' : err.message;
    return res.status(400).json({ error: msg });
  }
  if (err && err.message === 'INVALID_FILE_TYPE') {
    return res.status(400).json({ error: 'Only JPG, PNG, WEBP, or GIF images are allowed.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Fleet Priority SaaS running at http://localhost:${PORT}`);
  startReminderScheduler();
});
