const fs = require('fs');
const path = require('path');
const express = require('express');
const { requireAuth, requireActiveSub } = require('./auth');
const { UPLOAD_DIR, uploadImage, uploadDoc, removeUploadedFile } = require('./uploads');
const db = require('./db');

// Vehicle-count ceiling per plan. Adjust to match what you sell in Stripe.
const PLAN_LIMITS = { basic: 10, pro: 50 };

// Fields only Pro accounts may set — matches the "VIN & insurance tracking"
// perk advertised on the pricing page. Enforced here, not just hidden in the
// UI, so a Basic account can't set them by calling the API directly.
const PRO_ONLY_FIELDS = ['vin', 'insProvider', 'insPolicy', 'insExpiration'];

const FIELDS = [
  'tag', 'tagExpiration', 'vin', 'year', 'make', 'model', 'status', 'mileage', 'tire', 'tireBrand',
  'paidOff', 'loanTotal', 'loanRemaining', 'monthlyPayment', 'note', 'mechName', 'mechPhone',
  'insProvider', 'insPolicy', 'insExpiration',
];
// Note: 'imagePath', 'insuranceDocPath', and 'insuranceDocName' are
// intentionally excluded from FIELDS — they're only ever set through their
// dedicated upload/delete routes below, never through the generic JSON
// create/update body.
// Note: 'loanAsOfDate' is intentionally excluded from FIELDS too — it's a
// server-stamped anchor (see stampLoanAsOfDate below), not something a
// client can set directly.

function pick(body, plan) {
  const out = {};
  FIELDS.forEach((f) => {
    if (PRO_ONLY_FIELDS.includes(f) && plan !== 'pro') return;
    if (body[f] !== undefined) out[f] = body[f];
  });
  return out;
}

// Stamp today's date as the reference point the payoff bar's monthly
// auto-decay counts forward from — either because "amount remaining" just
// changed, or because a monthly payment was just turned on for a vehicle
// that didn't have an anchor date yet. Otherwise leave it alone, so editing
// an unrelated field (mileage, status, etc.) doesn't reset the countdown.
function stampLoanAsOfDate(data, existing) {
  if (data.loanRemaining === undefined || data.loanRemaining === '') return;
  const remainingChanged = String(data.loanRemaining) !== String((existing && existing.loanRemaining) ?? '');
  const monthlySet = data.monthlyPayment !== undefined && data.monthlyPayment !== '' && Number(data.monthlyPayment) > 0;
  const hasAnchorAlready = !!(existing && existing.loanAsOfDate);
  if (remainingChanged || (monthlySet && !hasAnchorAlready)) {
    data.loanAsOfDate = new Date().toISOString().slice(0, 10);
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
  const data = pick(req.body || {}, req.user.plan);
  stampLoanAsOfDate(data, undefined);
  const vehicle = db.createVehicle(req.user.id, data);
  res.status(201).json({ vehicle });
});

router.put('/:id', (req, res) => {
  const existing = db.getVehicle(req.user.id, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Vehicle not found.' });
  const data = pick(req.body || {}, req.user.plan);
  stampLoanAsOfDate(data, existing);
  const vehicle = db.updateVehicle(req.user.id, req.params.id, data);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
  res.json({ vehicle });
});

router.delete('/:id', (req, res) => {
  const existing = db.getVehicle(req.user.id, req.params.id);
  const ok = db.deleteVehicle(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Vehicle not found.' });
  if (existing) {
    removeUploadedFile(existing.imagePath);
    removeUploadedFile(existing.insuranceDocPath);
  }
  db.listMaintenanceForVehicle(req.user.id, req.params.id).forEach((r) => removeUploadedFile(r.receiptPath));
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
router.post('/:id/image', uploadImage.single('image'), (req, res) => {
  const vehicle = db.getVehicle(req.user.id, req.params.id);
  if (!vehicle) {
    if (req.file) removeUploadedFile(req.file.filename);
    return res.status(404).json({ error: 'Vehicle not found.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided.' });
  }
  removeUploadedFile(vehicle.imagePath);
  const updated = db.updateVehicle(req.user.id, req.params.id, { imagePath: req.file.filename });
  res.json({ vehicle: updated });
});

// Remove a vehicle's photo.
router.delete('/:id/image', (req, res) => {
  const vehicle = db.getVehicle(req.user.id, req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
  removeUploadedFile(vehicle.imagePath);
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

/* ---------------- Insurance document endpoints (Pro-only, like the rest of insurance tracking) ---------------- */

// Upload/replace a vehicle's insurance policy document (PDF or image).
router.post('/:id/insurance-doc', uploadDoc.single('doc'), (req, res) => {
  const vehicle = db.getVehicle(req.user.id, req.params.id);
  if (!vehicle) {
    if (req.file) removeUploadedFile(req.file.filename);
    return res.status(404).json({ error: 'Vehicle not found.' });
  }
  if (req.user.plan !== 'pro') {
    if (req.file) removeUploadedFile(req.file.filename);
    return res.status(403).json({ error: 'Insurance document uploads are a Pro feature.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided.' });
  }
  removeUploadedFile(vehicle.insuranceDocPath);
  const updated = db.updateVehicle(req.user.id, req.params.id, {
    insuranceDocPath: req.file.filename,
    insuranceDocName: req.file.originalname,
  });
  res.json({ vehicle: updated });
});

// Remove a vehicle's insurance document.
router.delete('/:id/insurance-doc', (req, res) => {
  const vehicle = db.getVehicle(req.user.id, req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
  removeUploadedFile(vehicle.insuranceDocPath);
  const updated = db.updateVehicle(req.user.id, req.params.id, { insuranceDocPath: null, insuranceDocName: null });
  res.json({ vehicle: updated });
});

// Serve a vehicle's insurance document — gated behind auth + ownership.
router.get('/:id/insurance-doc', (req, res) => {
  const vehicle = db.getVehicle(req.user.id, req.params.id);
  if (!vehicle || !vehicle.insuranceDocPath) return res.status(404).end();
  const full = path.join(UPLOAD_DIR, vehicle.insuranceDocPath);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});

module.exports = router;
