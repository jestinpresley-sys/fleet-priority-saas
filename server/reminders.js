// Periodic sweep that emails users about tag/insurance/maintenance alerts —
// the email counterpart to the in-app Notifications page. Runs inside this
// same Node process (there's no separate job runner in this app), so it's
// just a timer, not a real cron daemon; see startReminderScheduler().

const { listUsers, updateUser } = require('./db');
const { buildAlerts } = require('./notifications');
const { sendEmail } = require('./mailer');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// How often the process checks for new reminders. Alerts are only ever
// emailed once (see dedupe key below), so checking more often than once a
// day is just about not missing a reminder if the server wasn't running at
// the "ideal" time — it doesn't risk repeat emails.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

// One key per (alert, the specific date driving it, severity) — not just
// the alert id — so if a tag/policy is renewed and later expires again,
// that's a new date and gets a fresh reminder instead of being silently
// suppressed forever by the first reminder we ever sent for that vehicle.
function reminderKey(alert) {
  return `${alert.id}|${alert.date || ''}|${alert.severity}`;
}

function buildDigestHtml(alerts) {
  const overdue = alerts.filter((a) => a.severity === 'overdue');
  const soon = alerts.filter((a) => a.severity === 'soon');
  const section = (title, list) => {
    if (!list.length) return '';
    const items = list.map((a) => `<li><strong>${escapeHtml(a.title)}</strong><br>${escapeHtml(a.detail)}</li>`).join('');
    return `<h3>${title}</h3><ul>${items}</ul>`;
  };
  return `
    <p>Here's what needs attention on your fleet:</p>
    ${section('Overdue', overdue)}
    ${section('Due soon', soon)}
    <p><a href="${APP_URL}/notifications.html">View all notifications</a></p>
  `;
}

async function checkAndSendReminders() {
  const users = listUsers();
  for (const user of users) {
    const isActive = user.subscriptionStatus === 'active' || user.subscriptionStatus === 'trialing';
    if (!isActive) continue;
    if (user.emailRemindersEnabled === false) continue;

    const alerts = buildAlerts(user.id, user.plan);
    const alreadySent = new Set(user.sentReminderKeys || []);
    const newAlerts = alerts.filter((a) => !alreadySent.has(reminderKey(a)));
    if (newAlerts.length === 0) continue;

    const count = newAlerts.length;
    const subject = `Fleet Priority: ${count} item${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} your attention`;
    try {
      await sendEmail({ to: user.email, subject, html: buildDigestHtml(newAlerts) });
    } catch (err) {
      console.error('[reminders] Failed to send digest to', user.email, err.message);
      continue; // don't mark as sent if we couldn't even attempt delivery
    }
    const updatedKeys = [...alreadySent, ...newAlerts.map(reminderKey)];
    updateUser(user.id, { sentReminderKeys: updatedKeys });
  }
}

function startReminderScheduler() {
  const runSweep = () => {
    checkAndSendReminders().catch((err) => console.error('[reminders] sweep failed:', err.message));
  };
  setTimeout(() => {
    runSweep();
    setInterval(runSweep, CHECK_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

module.exports = { checkAndSendReminders, startReminderScheduler };
