const fs = require('fs');
const path = require('path');
const express = require('express');
const { requireAuth, requireActiveSub } = require('./auth');
const { UPLOAD_DIR, uploadImage, removeUploadedFile } = require('./uploads');
const db = require('./db');

const INSPECTION_TYPES = ['Check-out', 'Check-in', 'Routine'];
const SEVERITIES = ['none', 'minor', 'major'];

// Fixed walkaround slots — every inspection has exactly these six, so a new
// inspection's photos line up one-to-one against the previous inspection's
// for before/after comparison, rather than the client having to match up
// free-form photos by hand.
const SLOTS = [
  { key: 'front', label: 'Front' },
  { key: 'rear', label: 'Rear' },
  { key: 'driverSide', label: 'Driver Side' },
  { key: 'passengerSide', label: 'Passenger Side' },
  { key: 'interior', label: 'Interior' },
  { key: 'odometer', label: 'Odometer' },
];
const SLOT_KEYS = SLOTS.map((s) => s.key);

function blankSlots() {
  return SLOTS.map(({ key }) => ({ key, note: '', severity: 'none', photoPath: null }));
}

function sanitizeSlotsPatch(input) {
  if (!Array.isArray(input)) return null;
  const byKey = {};
  input.forEach((s) => { if (s && SLOT_KEYS.includes(s.key)) byKey[s.key] = s; });
  return SLOT_KEYS.map((key) => {
    const s = byKey[key] || {};
    return {
      key,
      note: typeof s.note === 'string' ? s.note.slice(0, 500) : '',
      severity: SEVERITIES.includes(s.severity) ? s.severity : 'none',
    };
  });
}

const router = express.Router();
router.use(requireAuth, requireActiveSub);

router.get('/vehicle/:vehicleId', (req, res) => {
  if (!db.getVehicle(req.user.id, req.params.vehicleId)) {
    return res.status(404).json({ error: 'Vehicle not found.' });
  }
  const records = db.listInspectionsForVehicle(req.user.id, req.params.vehicleId)
    .slice()
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ records, slots: SLOTS });
});

router.post('/', (req, res) => {
  const { vehicleId, type, date, odometer } = req.body || {};
  if (!vehicleId || !db.getVehicle(req.user.id, vehicleId)) {
    return res.status(400).json({ error: 'A valid vehicle is required.' });
  }
  if (!date) {
    return res.status(400).json({ error: 'Date is required.' });
  }
  const slots = sanitizeSlotsPatch((req.body || {}).slots) || blankSlots();
  // Photos come in via separate per-slot upload calls after this create
  // returns an id, same two-step pattern as vehicle photos and receipts.
  slots.forEach((s) => { s.photoPath = null; });
  const record = db.createInspection(req.user.id, {
    vehicleId,
    type: INSPECTION_TYPES.includes(type) ? type : 'Routine',
    date,
    odometer: odometer || '',
    slots,
  });
  res.status(201).json({ record });
});

router.put('/:id', (req, res) => {
  const existing = db.getInspection(req.user.id, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Record not found.' });
  const patch = {};
  const { type, date, odometer, slots } = req.body || {};
  if (type !== undefined) patch.type = INSPECTION_TYPES.includes(type) ? type : existing.type;
  if (date !== undefined) patch.date = date;
  if (odometer !== undefined) patch.odometer = odometer;
  if (slots !== undefined) {
    // Preserve each slot's existing photoPath — this endpoint only ever
    // touches note/severity, never photos (those go through the dedicated
    // upload/remove routes below).
    const incoming = sanitizeSlotsPatch(slots) || blankSlots();
    patch.slots = incoming.map((s) => {
      const prev = existing.slots.find((p) => p.key === s.key);
      return { ...s, photoPath: prev ? prev.photoPath : null };
    });
  }
  const record = db.updateInspection(req.user.id, req.params.id, patch);
  res.json({ record });
});

router.delete('/:id', (req, res) => {
  const existing = db.getInspection(req.user.id, req.params.id);
  const ok = db.deleteInspection(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Record not found.' });
  if (existing) existing.slots.forEach((s) => removeUploadedFile(s.photoPath));
  res.json({ ok: true });
});

/* ---------------- Per-slot photo endpoints ---------------- */

router.post('/:id/photo/:slot', uploadImage.single('photo'), (req, res) => {
  const record = db.getInspection(req.user.id, req.params.id);
  if (!record || !SLOT_KEYS.includes(req.params.slot)) {
    if (req.file) removeUploadedFile(req.file.filename);
    return res.status(404).json({ error: 'Record not found.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided.' });
  }
  const slots = record.slots.map((s) => {
    if (s.key !== req.params.slot) return s;
    if (s.photoPath) removeUploadedFile(s.photoPath);
    return { ...s, photoPath: req.file.filename };
  });
  const updated = db.updateInspection(req.user.id, req.params.id, { slots });
  res.json({ record: updated });
});

router.delete('/:id/photo/:slot', (req, res) => {
  const record = db.getInspection(req.user.id, req.params.id);
  if (!record || !SLOT_KEYS.includes(req.params.slot)) {
    return res.status(404).json({ error: 'Record not found.' });
  }
  const slots = record.slots.map((s) => {
    if (s.key !== req.params.slot) return s;
    removeUploadedFile(s.photoPath);
    return { ...s, photoPath: null };
  });
  const updated = db.updateInspection(req.user.id, req.params.id, { slots });
  res.json({ record: updated });
});

// Serve a slot's photo — gated behind auth + ownership, like vehicle photos.
router.get('/:id/photo/:slot', (req, res) => {
  const record = db.getInspection(req.user.id, req.params.id);
  const slot = record && record.slots.find((s) => s.key === req.params.slot);
  if (!slot || !slot.photoPath) return res.status(404).end();
  const full = path.join(UPLOAD_DIR, slot.photoPath);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});

module.exports = { router, SLOTS, INSPECTION_TYPES, SEVERITIES };
