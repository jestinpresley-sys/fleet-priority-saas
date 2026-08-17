const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// Same DATA_DIR override as server/db.js — keeps uploads on the same
// persistent disk as the database in production. Shared by every route
// that stores a file (vehicle photos, insurance docs, maintenance receipts)
// so they all land in one place regardless of which router handled them.
const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const IMAGE_EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
// Insurance policies and receipts are commonly PDFs, but a photo of a
// paper receipt is just as common, so documents accept both.
const DOC_EXT_BY_MIME = { ...IMAGE_EXT_BY_MIME, 'application/pdf': '.pdf' };

function makeUploader(extByMime, maxBytes) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOAD_DIR),
      filename: (req, file, cb) => {
        const ext = extByMime[file.mimetype] || path.extname(file.originalname || '').toLowerCase() || '';
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: maxBytes },
    fileFilter: (req, file, cb) => {
      if (!extByMime[file.mimetype]) return cb(new Error('INVALID_FILE_TYPE'));
      cb(null, true);
    },
  });
}

function removeUploadedFile(filename) {
  if (!filename) return;
  const full = path.join(UPLOAD_DIR, filename);
  if (fs.existsSync(full)) {
    try { fs.unlinkSync(full); } catch (e) { console.error('Could not remove uploaded file:', e.message); }
  }
}

module.exports = {
  UPLOAD_DIR,
  uploadImage: makeUploader(IMAGE_EXT_BY_MIME, 5 * 1024 * 1024), // 5MB
  uploadDoc: makeUploader(DOC_EXT_BY_MIME, 8 * 1024 * 1024), // 8MB
  removeUploadedFile,
};
