// Minimal JSON-file datastore.
//
// This is intentionally simple so the app has zero native dependencies and
// runs anywhere Node runs. It's fine for validating the product and an early
// batch of customers. Before you scale past a handful of concurrent users,
// swap this module for a real database (Postgres is the natural choice) —
// the function signatures below are the seam to do that behind.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// DATA_DIR can be overridden via env var so it can point at a mounted
// persistent disk in production (path varies by host) instead of a folder
// inside the deployed code checkout.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], vehicles: [], maintenance: [], sessions: [] }, null, 2));
  }
}
ensureDB();

// The whole DB is kept in memory after the first load and mutated in place —
// every read and write below goes through this single object, never a fresh
// disk read. That's what keeps things correct: disk writes are queued and
// happen asynchronously (see persist() below), so a function that reads the
// file fresh from disk mid-request could read a stale snapshot from before
// an earlier write in the same request had actually flushed, then write
// that stale snapshot back and silently undo the earlier change — which is
// exactly what used to happen when deleting a vehicle also cascaded into
// deleting its maintenance records (two separate read-modify-write cycles,
// one clobbering the other). Keeping one shared in-memory copy makes every
// mutation immediately visible to the next one, regardless of disk timing.
let cache = null;
function db() {
  if (!cache) {
    cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // Defensive: older db.json files predate the maintenance log / sessions features.
    if (!Array.isArray(cache.maintenance)) cache.maintenance = [];
    if (!Array.isArray(cache.sessions)) cache.sessions = [];
  }
  return cache;
}

// Serialize writes so they hit disk in order. Reads always come from the
// in-memory cache above, not this file, so persist() doesn't need to be
// awaited for correctness — it's just making sure the on-disk copy catches
// up, in the order changes actually happened.
let writeQueue = Promise.resolve();
function persist() {
  writeQueue = writeQueue.then(
    () => fs.writeFileSync(DB_FILE, JSON.stringify(cache, null, 2))
  );
  return writeQueue;
}

/* ---------------- Users ---------------- */

function listUsers() {
  return db().users;
}
function getUserByEmail(email) {
  return db().users.find((u) => u.email === email) || null;
}
function getUserById(id) {
  return db().users.find((u) => u.id === id) || null;
}
function getUserByStripeCustomerId(customerId) {
  return db().users.find((u) => u.stripeCustomerId === customerId) || null;
}
function createUser({ email, passwordHash }) {
  const user = {
    id: crypto.randomUUID(),
    email,
    passwordHash,
    stripeCustomerId: null,
    subscriptionId: null,
    subscriptionStatus: 'inactive', // inactive | trialing | active | past_due | canceled
    plan: null, // 'basic' | 'pro'
    createdAt: new Date().toISOString(),
  };
  db().users.push(user);
  persist();
  return user;
}
function updateUser(id, patch) {
  const users = db().users;
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  users[idx] = { ...users[idx], ...patch };
  persist();
  return users[idx];
}

/* ---------------- Vehicles ---------------- */

function listVehicles(userId) {
  return db().vehicles.filter((v) => v.userId === userId);
}
function getVehicle(userId, id) {
  return db().vehicles.find((v) => v.id === id && v.userId === userId) || null;
}
function countVehicles(userId) {
  return listVehicles(userId).length;
}
function createVehicle(userId, data) {
  const vehicle = {
    id: crypto.randomUUID(),
    userId,
    ...data,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db().vehicles.push(vehicle);
  persist();
  return vehicle;
}
function updateVehicle(userId, id, patch) {
  const vehicles = db().vehicles;
  const idx = vehicles.findIndex((v) => v.id === id && v.userId === userId);
  if (idx === -1) return null;
  vehicles[idx] = { ...vehicles[idx], ...patch, updatedAt: new Date().toISOString() };
  persist();
  return vehicles[idx];
}
function deleteVehicle(userId, id) {
  const data = db();
  const before = data.vehicles.length;
  data.vehicles = data.vehicles.filter((v) => !(v.id === id && v.userId === userId));
  persist();
  return data.vehicles.length < before;
}

/* ---------------- Maintenance records ---------------- */

function listMaintenance(userId) {
  return db().maintenance.filter((m) => m.userId === userId);
}
function listMaintenanceForVehicle(userId, vehicleId) {
  return listMaintenance(userId).filter((m) => m.vehicleId === vehicleId);
}
function getMaintenance(userId, id) {
  return db().maintenance.find((m) => m.id === id && m.userId === userId) || null;
}
function createMaintenance(userId, data) {
  const record = {
    id: crypto.randomUUID(),
    userId,
    ...data,
    createdAt: new Date().toISOString(),
  };
  db().maintenance.push(record);
  persist();
  return record;
}
function updateMaintenance(userId, id, patch) {
  const records = db().maintenance;
  const idx = records.findIndex((m) => m.id === id && m.userId === userId);
  if (idx === -1) return null;
  records[idx] = { ...records[idx], ...patch };
  persist();
  return records[idx];
}
function deleteMaintenance(userId, id) {
  const data = db();
  const before = data.maintenance.length;
  data.maintenance = data.maintenance.filter((m) => !(m.id === id && m.userId === userId));
  persist();
  return data.maintenance.length < before;
}
function deleteMaintenanceForVehicle(userId, vehicleId) {
  const data = db();
  data.maintenance = data.maintenance.filter((m) => !(m.vehicleId === vehicleId && m.userId === userId));
  persist();
}

/* ---------------- Sessions (one per login, backs "linked devices") ---------------- */

function createSession(userId, userAgent) {
  const now = new Date().toISOString();
  const session = {
    id: crypto.randomUUID(),
    userId,
    userAgent: userAgent || '',
    createdAt: now,
    lastSeenAt: now,
  };
  db().sessions.push(session);
  persist();
  return session;
}
function getSession(id) {
  return db().sessions.find((s) => s.id === id) || null;
}
function listSessionsForUser(userId) {
  return db().sessions.filter((s) => s.userId === userId);
}
// Called on every authenticated request — throttled so normal browsing
// doesn't trigger a disk write on every single API call.
function touchSession(id) {
  const session = db().sessions.find((s) => s.id === id);
  if (!session) return;
  if (Date.now() - new Date(session.lastSeenAt).getTime() < 60 * 1000) return;
  session.lastSeenAt = new Date().toISOString();
  persist();
}
function deleteSession(id) {
  const data = db();
  const before = data.sessions.length;
  data.sessions = data.sessions.filter((s) => s.id !== id);
  persist();
  return data.sessions.length < before;
}
function deleteSessionsForUserExcept(userId, exceptId) {
  const data = db();
  data.sessions = data.sessions.filter((s) => !(s.userId === userId && s.id !== exceptId));
  persist();
}

module.exports = {
  listUsers,
  getUserByEmail,
  getUserById,
  getUserByStripeCustomerId,
  createUser,
  updateUser,
  listVehicles,
  getVehicle,
  countVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  listMaintenance,
  listMaintenanceForVehicle,
  getMaintenance,
  createMaintenance,
  updateMaintenance,
  deleteMaintenance,
  deleteMaintenanceForVehicle,
  createSession,
  getSession,
  listSessionsForUser,
  touchSession,
  deleteSession,
  deleteSessionsForUserExcept,
};
