const express = require('express');
const { requireAuth, requireActiveSub } = require('./auth');
const db = require('./db');

// How far ahead an upcoming expiration/due date starts showing as an alert.
const WARN_DAYS = 30;

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

function severityFor(days) {
  if (days < 0) return 'overdue';
  if (days <= WARN_DAYS) return 'soon';
  return null;
}

function vehicleLabel(v) {
  return `${v.year || ''} ${v.make || ''} ${v.model || ''}`.replace(/\s+/g, ' ').trim() || 'Vehicle';
}

function buildAlerts(userId, plan) {
  const vehicles = db.listVehicles(userId);
  const maintenance = db.listMaintenance(userId);
  const vehicleById = {};
  vehicles.forEach((v) => { vehicleById[v.id] = v; });

  const alerts = [];

  vehicles.forEach((v) => {
    const label = vehicleLabel(v);

    const tagDays = daysUntil(v.tagExpiration);
    if (tagDays !== null) {
      const severity = severityFor(tagDays);
      if (severity) {
        alerts.push({
          id: `tag-${v.id}`,
          type: 'tag',
          severity,
          vehicleId: v.id,
          title: `${label} — tag ${severity === 'overdue' ? 'expired' : 'expiring soon'}`,
          detail: severity === 'overdue'
            ? `Expired ${Math.abs(tagDays)} day(s) ago (${v.tagExpiration})`
            : `Expires in ${tagDays} day(s) (${v.tagExpiration})`,
          days: tagDays,
          date: v.tagExpiration,
        });
      }
    }

    // Insurance tracking is a Pro-only feature (see PRO_ONLY_FIELDS in fleet.js) —
    // don't surface alerts for a field a Basic account can't see or edit.
    const insDays = plan === 'pro' ? daysUntil(v.insExpiration) : null;
    if (insDays !== null) {
      const severity = severityFor(insDays);
      if (severity) {
        alerts.push({
          id: `ins-${v.id}`,
          type: 'insurance',
          severity,
          vehicleId: v.id,
          title: `${label} — insurance ${severity === 'overdue' ? 'expired' : 'expiring soon'}`,
          detail: severity === 'overdue'
            ? `Expired ${Math.abs(insDays)} day(s) ago (${v.insExpiration})`
            : `Expires in ${insDays} day(s) (${v.insExpiration})`,
          days: insDays,
          date: v.insExpiration,
        });
      }
    }
  });

  maintenance.forEach((m) => {
    const days = daysUntil(m.nextDue);
    if (days === null) return;
    const severity = severityFor(days);
    if (!severity) return;
    const v = vehicleById[m.vehicleId];
    const label = v ? vehicleLabel(v) : 'Vehicle';
    alerts.push({
      id: `maint-${m.id}`,
      type: 'maintenance',
      severity,
      vehicleId: m.vehicleId,
      title: `${label} — ${m.type || 'service'} ${severity === 'overdue' ? 'overdue' : 'due soon'}`,
      detail: severity === 'overdue'
        ? `Was due ${Math.abs(days)} day(s) ago (${m.nextDue})`
        : `Due in ${days} day(s) (${m.nextDue})`,
      days,
      date: m.nextDue,
    });
  });

  alerts.sort((a, b) => a.days - b.days);
  return alerts;
}

const router = express.Router();
router.use(requireAuth, requireActiveSub);

router.get('/', (req, res) => {
  res.json({ alerts: buildAlerts(req.user.id, req.user.plan) });
});

// buildAlerts is also used by server/reminders.js, so the email digest
// computes alerts with the exact same rules as the in-app Notifications
// page — no risk of the two disagreeing about what counts as "due soon".
module.exports = { router, buildAlerts };
