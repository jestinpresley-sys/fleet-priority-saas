const express = require('express');
const { requireAuth, requireActiveSub } = require('./auth');
const db = require('./db');

const SERVICE_TYPES = ['Oil Change', 'Tires', 'Brakes', 'Battery', 'Inspection', 'Repair', 'Other'];

const router = express.Router();
router.use(requireAuth, requireActiveSub);

// Flat list across the whole fleet — used by the Fleet Overview page.
router.get('/', (req, res) => {
  res.json({ records: db.listMaintenance(req.user.id) });
});

router.post('/', (req, res) => {
  const { vehicleId, date, type, cost, mileage, note } = req.body || {};
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
  });
  res.status(201).json({ record });
});

router.put('/:id', (req, res) => {
  const patch = {};
  ['vehicleId', 'date', 'type', 'cost', 'mileage', 'note'].forEach((f) => {
    if (req.body[f] !== undefined) {
      patch[f] = f === 'cost' ? Number(req.body[f]) || 0 : req.body[f];
    }
  });
  const record = db.updateMaintenance(req.user.id, req.params.id, patch);
  if (!record) return res.status(404).json({ error: 'Record not found.' });
  res.json({ record });
});

router.delete('/:id', (req, res) => {
  const ok = db.deleteMaintenance(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Record not found.' });
  res.json({ ok: true });
});

module.exports = { router, SERVICE_TYPES };
