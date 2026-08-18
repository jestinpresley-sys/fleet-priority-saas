#!/usr/bin/env node
// Grants an account an active subscription without going through Stripe —
// for comping a client, a demo, or your own testing.
//
// Usage:
//   node scripts/comp-account.js <email> <basic|pro>
//
// IMPORTANT: the app server must be STOPPED while this runs, and started
// again afterward — not just restarted after. server/db.js keeps the whole
// database in memory once the server has loaded it, and only ever writes
// that in-memory copy back to disk. If the server is left running while
// this script edits data/db.json directly, the next time the server writes
// anything at all (any request, from any user), it flushes its own stale
// in-memory copy over this script's change and silently undoes it. This
// script checks for a running server and refuses to proceed if it finds
// one, rather than risk that.

const http = require('http');
const path = require('path');

const [, , emailArg, planArg] = process.argv;

if (!emailArg || !['basic', 'pro'].includes(planArg)) {
  console.error('Usage: node scripts/comp-account.js <email> <basic|pro>');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

function isServerRunning() {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port: PORT, path: '/login.html', timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  const running = await isServerRunning();
  if (running) {
    console.error(
      `\nThe app appears to be running on port ${PORT}.\n` +
      'Stop it first (e.g. `pm2 stop fleet-priority`), THEN run this script, THEN start it again.\n' +
      "Editing the database while the server is up gets silently overwritten — that's not a guess, it reproduces every time.\n"
    );
    process.exit(1);
  }

  // Only require db.js — and therefore only load its in-memory cache —
  // after confirming nothing else has it loaded.
  const db = require(path.join(__dirname, '..', 'server', 'db'));

  const email = emailArg.trim().toLowerCase();
  const user = db.getUserByEmail(email);
  if (!user) {
    console.error(`No account found for ${email}. They need to sign up first (at /signup.html) before this can comp them.`);
    process.exit(1);
  }

  db.updateUser(user.id, { plan: planArg, subscriptionStatus: 'active' });
  console.log(`\nDone — ${email} is now on the ${planArg} plan with an active subscription, no Stripe involved.`);
  console.log('You can start the app again now.\n');
}

main();
