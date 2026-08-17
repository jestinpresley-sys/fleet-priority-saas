const fs = require('fs');
const path = require('path');
const express = require('express');
const { requireAuth, requireActiveSub } = require('./auth');
const { UPLOAD_DIR, uploadDoc, removeUploadedFile } = require('./uploads');
const db = require('./db');

const SERVICE_TYPES = ['Oil Change', 'Gas', 'Tires', 'Brakes', 'Battery', 'Inspection', 'Repair', 'Other'];

const router = express.Router();
router.use(requireAuth, requireActiveSub);

// Flat list across the whole fleet — used by the Fleet Overview page.
router.get('/', (req, res) => {
  res.json({ records: db.listMaintenance(req.user.id) });
});

router.post('/', (req, res) => {
  const { vehicleId, date, type, cost, mileage, note, nextDue } = req.body || {};
  if (!vehicleId || !db.getVehicle(req.user.id, vehicleId)) {
    return res.status(400).json({ error: 'A valid vehicle is required.' });
  }
  if (!date) {
    return res.status(400).json({ error: 'Date is required.' });
  }
  const numericCost = Number(cost);
  const record = db.createMaintenance(req.user.id, {
    vehicleId,
    date,
    type: type || 'Other',
    cost: Number.isFinite(numericCost) ? numericCost : 0,
    mileage: mileage || '',
    note: note || '',
    nextDue: nextDue || '',
  });
  res.status(201).json({ record });
});

router.put('/:id', (req, res) => {
  const patch = {};
  ['vehicleId', 'date', 'type', 'cost', 'mileage', 'note', 'nextDue'].forEach((f) => {
    if (req.body[f] !== undefined) {
      patch[f] = f === 'cost' ? Number(req.body[f]) || 0 : req.body[f];
    }
  });
  const record = db.updateMaintenance(req.user.id, req.params.id, patch);
  if (!record) return res.status(404).json({ error: 'Record not found.' });
  res.json({ record });
});

router.delete('/:id', (req, res) => {
  const existing = db.getMaintenance(req.user.id, req.params.id);
  const ok = db.deleteMaintenance(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Record not found.' });
  if (existing) removeUploadedFile(existing.receiptPath);
  res.json({ ok: true });
});

/* ---------------- Receipt endpoints ---------------- */
// A maintenance record's own attachment (e.g. an oil-change receipt) — a
// PDF or a photo of a paper receipt.

// Upload/replace a record's receipt.
router.post('/:id/receipt', uploadDoc.single('receipt'), (req, res) => {
  const record = db.getMaintenance(req.user.id, req.params.id);
  if (!record) {
    if (req.file) removeUploadedFile(req.file.filename);
    return res.status(404).json({ error: 'Record not found.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided.' });
  }
  removeUploadedFile(record.receiptPath);
  const updated = db.updateMaintenance(req.user.id, req.params.id, {
    receiptPath: req.file.filename,
    receiptName: req.file.originalname,
  });
  res.json({ record: updated });
});

// Remove a record's receipt.
router.delete('/:id/receipt', (req, res) => {
  const record = db.getMaintenance(req.user.id, req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found.' });
  removeUploadedFile(record.receiptPath);
  const updated = db.updateMaintenance(req.user.id, req.params.id, { receiptPath: null, receiptName: null });
  res.json({ record: updated });
});

// Serve a record's receipt — gated behind auth + ownership.
router.get('/:id/receipt', (req, res) => {
  const record = db.getMaintenance(req.user.id, req.params.id);
  if (!record || !record.receiptPath) return res.status(404).end();
  const full = path.join(UPLOAD_DIR, record.receiptPath);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});

module.exports = { router, SERVICE_TYPES };
