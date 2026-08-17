const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { requireAuth, requireActiveSub } = require('./auth');
const db = require('./db');

// Vehicle-count ceiling per plan. Adjust to match what you sell in Stripe.
const PLAN_LIMITS = { basic: 10, pro: 50 };

// Fields only Pro accounts may set — matches the "VIN & insurance tracking"
// perk advertised on the pricing page. Enforced here, not just hidden in the
// UI, so a Basic account can't set them by calling the API directly.
const PRO_ONLY_FIELDS = ['vin', 'insProvider', 'insPolicy', 'insExpiration'];

const FIELDS = [
  'tag', 'tagExpiration', 'vin', 'year', 'make', 'model', 'status', 'mileage', 'tire', 'tireBrand',
  'paidOff', 'loanTotal', 'loanRemaining', 'note', 'mechName', 'mechPhone', 'renter',
  'insProvider', 'insPolicy', 'insExpiration',
];
// Note: 'imagePath' is intentionally excluded from FIELDS — it's only ever
// set through the dedicated image upload/delete routes below, never through
// the generic JSON create/update body.

function pick(body, plan) {
  const out = {};
  FIELDS.forEach((f) => {
    if (PRO_ONLY_FIELDS.includes(f) && plan !== 'pro') return;
    if (body[f] !== undefined) out[f] = body[f];
  });
  return out;
}

/* ---------------- Photo storage ---------------- */
// Same DATA_DIR override as server/db.js — keeps uploads on the same
// persistent disk as the database in production.
const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = EXT_BY_MIME[file.mimetype] || path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error('INVALID_FILE_TYPE'));
    }
    cb(null, true);
  },
});

function removeImageFile(imagePath) {
  if (!imagePath) return;
  const full = path.join(UPLOAD_DIR, imagePath);
  if (fs.existsSync(full)) {
    try { fs.unlinkSync(full); } catch (e) { console.error('Could not remove image file:', e.message); }
  }
}

const router = express.Router();
router.use(requireAuth, requireActiveSub);

router.get('/', (req, res) => {
  res.json({ vehicles: db.listVehicles(req.user.id) });
});

router.post('/', (req, res) => {
  const limit = PLAN_LIMITS[req.user.plan] ?? 0;
  if (db.countVehicles(req.user.id) >= limit) {
    return res.status(403).json({
      error: `Your ${req.user.plan || 'current'} plan allows up to ${limit} vehicles. Upgrade to add more.`,
    });
  }
  const vehicle = db.createVehicle(req.user.id, pick(req.body || {}, req.user.plan));
  res.status(201).json({ vehicle });
});

router.put('/:id', (req, res) => {
  const vehicle = db.updateVehicle(req.user.id, req.params.id, pick(req.body || {}, req.user.plan));
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
  res.json({ vehicle });
});

router.delete('/:id', (req, res) => {
  const existing = db.getVehicle(req.user.id, req.params.id);
  const ok = db.deleteVehicle(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Vehicle not found.' });
  if (existing) removeImageFile(existing.imagePath);
  db.deleteMaintenanceForVehicle(req.user.id, req.params.id);
  res.json({ ok: true });
});

/* ---------------- Maintenance history (scoped to one vehicle) ---------------- */
// Flat, fleet-wide maintenance endpoints live in server/maintenance.js
// (mounted at /api/maintenance) — this is just a convenience read for
// populating a single vehicle's history in the edit modal.
router.get('/:id/maintenance', (req, res) => {
  const vehicle = db.getVehicle(req.user.id, req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
  res.json({ records: db.listMaintenanceForVehicle(req.user.id, req.params.id) });
});

/* ---------------- Photo endpoints ---------------- */

// Upload/replace a vehicle's photo.
router.post('/:id/image', upload.single('image'), (req, res) => {
  const vehicle = db.getVehicle(req.user.id, req.params.id);
  if (!vehicle) {
    if (req.file) removeImageFile(req.file.filename);
    return res.status(404).json({ error: 'Vehicle not found.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided.' });
  }
  removeImageFile(vehicle.imagePath);
  const updated = db.updateVehicle(req.user.id, req.params.id, { imagePath: req.file.filename });
  res.json({ vehicle: updated });
});

// Remove a vehicle's photo.
router.delete('/:id/image', (req, res) => {
  const vehicle = db.getVehicle(req.user.id, req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
  removeImageFile(vehicle.imagePath);
  const updated = db.updateVehicle(req.user.id, req.params.id, { imagePath: null });
  res.json({ vehicle: updated });
});

// Serve a vehicle's photo — gated behind auth + ownership, not a public static path.
router.get('/:id/image', (req, res) => {
  const vehicle = db.getVehicle(req.user.id, req.params.id);
  if (!vehicle || !vehicle.imagePath) return res.status(404).end();
  const full = path.join(UPLOAD_DIR, vehicle.imagePath);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});

module.exports = router;
