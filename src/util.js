'use strict';

const path = require('path');

// Turns whatever the browser sent into a safe file name that is valid on
// Windows, macOS and Linux. Returns null when nothing usable is left.
function sanitizeFileName(raw) {
  let n = String(raw == null ? '' : raw).normalize('NFC');
  n = n.replace(/[\u0000-\u001f\u007f]/g, '');
  n = n.split(/[\\/]/).pop();
  n = n.replace(/[<>:"|?*]/g, '_');
  n = n.replace(/[. ]+$/, '').replace(/^\s+/, '');
  if (!n || n === '.' || n === '..') return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = '_' + n;

  // Keep the whole name under ~200 bytes while preserving the extension.
  if (Buffer.byteLength(n) > 200) {
    const ext = path.extname(n);
    let base = n.slice(0, n.length - ext.length);
    while (Buffer.byteLength(base + ext) > 200 && base.length > 1) base = base.slice(0, -1);
    n = base + ext;
  }
  return n;
}

function cleanNickname(raw) {
  const n = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.length < 2 || n.length > 40) return null;
  return n;
}

// Types that are safe to display inside the browser. Everything else is
// forced to download, so a malicious .html/.svg can never run on this site.
const INLINE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};

function inlineTypeFor(name) {
  return INLINE_TYPES[path.extname(name).toLowerCase()] || null;
}

function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}

// Content-Disposition header that survives accents, Arabic, spaces, etc.
function contentDisposition(type, name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return type + '; filename="' + fallback + '"; filename*=UTF-8\'\'' + encoded;
}

module.exports = { sanitizeFileName, cleanNickname, inlineTypeFor, csvCell, contentDisposition };
