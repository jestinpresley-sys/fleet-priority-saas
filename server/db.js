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
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], vehicles: [] }, null, 2));
  }
}
ensureDB();

function readRaw() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

// Serialize writes so concurrent requests can't clobber each other.
let writeQueue = Promise.resolve();
function writeRaw(data) {
  writeQueue = writeQueue.then(
    () => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2))
  );
  return writeQueue;
}

/* ---------------- Users ---------------- */

function getUserByEmail(email) {
  return readRaw().users.find((u) => u.email === email) || null;
}
function getUserById(id) {
  return readRaw().users.find((u) => u.id === id) || null;
}
function getUserByStripeCustomerId(customerId) {
  return readRaw().users.find((u) => u.stripeCustomerId === customerId) || null;
}
function createUser({ email, passwordHash }) {
  const db = readRaw();
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
  db.users.push(user);
  writeRaw(db);
  return user;
}
function updateUser(id, patch) {
  const db = readRaw();
  const idx = db.users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  db.users[idx] = { ...db.users[idx], ...patch };
  writeRaw(db);
  return db.users[idx];
}

/* ---------------- Vehicles ---------------- */

function listVehicles(userId) {
  return readRaw().vehicles.filter((v) => v.userId === userId);
}
function getVehicle(userId, id) {
  return readRaw().vehicles.find((v) => v.id === id && v.userId === userId) || null;
}
function countVehicles(userId) {
  return listVehicles(userId).length;
}
function createVehicle(userId, data) {
  const db = readRaw();
  const vehicle = {
    id: crypto.randomUUID(),
    userId,
    ...data,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.vehicles.push(vehicle);
  writeRaw(db);
  return vehicle;
}
function updateVehicle(userId, id, patch) {
  const db = readRaw();
  const idx = db.vehicles.findIndex((v) => v.id === id && v.userId === userId);
  if (idx === -1) return null;
  db.vehicles[idx] = { ...db.vehicles[idx], ...patch, updatedAt: new Date().toISOString() };
  writeRaw(db);
  return db.vehicles[idx];
}
function deleteVehicle(userId, id) {
  const db = readRaw();
  const before = db.vehicles.length;
  db.vehicles = db.vehicles.filter((v) => !(v.id === id && v.userId === userId));
  writeRaw(db);
  return db.vehicles.length < before;
}

module.exports = {
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
};
