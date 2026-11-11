'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const express = require('express');
const cookieSession = require('cookie-session');

const config = require('./src/config');
const { Store } = require('./src/db');
const { createAuth } = require('./src/auth');
const perms = require('./src/permissions');
const editRoutes = require('./src/edit-routes');
const { sanitizeFileName, cleanNickname, inlineTypeFor, csvCell, contentDisposition } = require('./src/util');

// ---------------------------------------------------------------- folders
for (const dir of [config.DATA_DIR, config.FILES_DIR, config.TRASH_DIR, config.TMP_DIR, config.CERT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
for (const f of fs.readdirSync(config.TMP_DIR)) {
  try { fs.unlinkSync(path.join(config.TMP_DIR, f)); } catch (_) { /* ignore */ }
}

const db = new Store(config.DB_FILE);
const { router: authRouter, requireAuth, requireNickname, requireChief } = createAuth({ config, db });

// Session secret: generated once and remembered, so staff stay signed in
// even after the server is restarted.
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    const existing = fs.readFileSync(config.SECRET_FILE, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (_) { /* create below */ }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(config.SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

// ------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only one change to the file list at a time, so two people uploading the same
// file name at the same moment cannot corrupt the record.
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(() => fn());
  lockChain = run.catch(() => {});
  return run;
}

async function moveReplacing(src, dest) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fsp.rename(src, dest);
      return;
    } catch (e) {
      // Windows refuses to replace a file that is being read at that instant.
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt === 5) throw e;
      await sleep(250 * (attempt + 1));
    }
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function touchNow(file) {
  const now = new Date();
  try { await fsp.utimes(file, now, now); } catch (_) { /* not important */ }
}

async function archiveCopy(fullPath, name, reason) {
  const dest = path.join(config.TRASH_DIR, stamp() + '__' + reason + '__' + name);
  await fsp.copyFile(fullPath, dest);
  await touchNow(dest);
}

async function purgeTrash() {
  if (!config.TRASH_DAYS) return;
  const cutoff = Date.now() - config.TRASH_DAYS * 24 * 3600 * 1000;
  for (const f of await fsp.readdir(config.TRASH_DIR)) {
    const full = path.join(config.TRASH_DIR, f);
    try {
      const st = await fsp.stat(full);
      if (st.isFile() && st.mtimeMs < cutoff) await fsp.unlink(full);
    } catch (_) { /* ignore */ }
  }
}

// Puts a finished temp file in place as the new version of a shared file and
// records it. Must be called inside withLock().
const lastArchive = new Map();
const COALESCE_MS = 10 * 60 * 1000;

async function installFile({ user, name, tmpPath, size, existing, inApp, label }) {
  const diskName = existing ? existing.name : name;
  const dest = path.join(config.FILES_DIR, diskName);
  const alreadyThere = fs.existsSync(dest);
  const key = db.fileKey(diskName);

  // While someone is typing in the editor, keep a safety copy at most every 10 minutes.
  if (alreadyThere && (!inApp || Date.now() - (lastArchive.get(key) || 0) > COALESCE_MS)) {
    await archiveCopy(dest, diskName, inApp ? 'edited' : 'replaced');
    lastArchive.set(key, Date.now());
  }
  await moveReplacing(tmpPath, dest);

  const now = new Date().toISOString();
  const isUpdate = !!existing || alreadyThere;
  const version = (existing ? existing.version : 0) + 1;
  db.putFile({
    name: diskName,
    size,
    version,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    updatedByEmail: user.email,
    updatedByNickname: user.nickname,
    editRoles: existing ? existing.editRoles || [] : [],
  });

  // Many quick saves by the same person become ONE line on the Scoreboard.
  const log = db.data.activity;
  const last = log[log.length - 1];
  if (label) {
    db.addActivity({ email: user.email, nickname: user.nickname, action: label.action, file: diskName, size, detail: label.detail || '' });
  } else if (inApp && isUpdate && last && last.email === user.email && last.file === diskName && last.action === 'Updated' &&
      /^Edited in the app/.test(last.detail || '') && Date.now() - Date.parse(last.ts) < COALESCE_MS) {
    const saves = (parseInt((/(\d+) saves/.exec(last.detail) || [0, 1])[1], 10) || 1) + 1;
    last.ts = now;
    last.size = size;
    last.detail = 'Edited in the app · ' + saves + ' saves';
  } else {
    db.addActivity({
      email: user.email,
      nickname: user.nickname,
      action: isUpdate ? 'Updated' : 'Uploaded',
      file: diskName,
      size,
      detail: inApp ? (isUpdate ? 'Edited in the app' : 'Created in the app') : '',
    });
  }
  db.commit();
  return { name: diskName, action: isUpdate ? 'Updated' : 'Uploaded', version };
}

function publicFile(f, ctx) {
  return {
    editKind: editRoutes.kindOf(f.name),
    editRoles: (f.editRoles || []).filter((id) => db.data.roles[id]),
    canEdit: perms.canModify(ctx, f, 'edit'),
    canDelete: perms.canModify(ctx, f, 'delete'),
    name: f.name,
    size: f.size,
    version: f.version,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    updatedBy: { email: f.updatedByEmail, nickname: f.updatedByNickname },
    previewable: !!inlineTypeFor(f.name),
  };
}

// -------------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');

// Everyone must use the one official address, otherwise Google sign-in cookies
// would get lost between "ip-address" and "name" versions of the site.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host || host === config.BASE_HOST) return next();
  if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(302, config.BASE_URL + req.originalUrl);
  res.status(400).json({ error: 'wrong_address', use: config.BASE_URL });
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; frame-src 'self'; object-src 'self'; base-uri 'self'; form-action 'self'"
  );
  next();
});

app.use(
  cookieSession({
    name: 'zp_session',
    keys: [loadSessionSecret()],
    maxAge: 30 * 24 * 3600 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.USE_HTTPS,
  })
);

// Blocks other websites from making a signed-in browser change things.
app.use((req, res, next) => {
  if ((req.path.startsWith('/api/') || req.path.startsWith('/auth/')) && !['GET', 'HEAD'].includes(req.method)) {
    if (req.headers['x-requested-with'] !== 'zp') return res.status(403).json({ error: 'bad_request' });
  }
  next();
});

app.use('/api', (req, res, next) => {
  if (req.session && req.session.email) presence.set(String(req.session.email).toLowerCase(), Date.now());
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(authRouter);

// ------------------------------------------------------------- public API
app.get('/api/config', (req, res) => {
  res.json({
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    googleConfigured: !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
  });
});

// ---------------------------------------------------------- signed-in API
function accessInfo(ctx) {
  return { isChief: ctx.chief, roleIds: ctx.roleIds, permissions: ctx.perms };
}

// Who has used the app in the last 20 seconds.
const presence = new Map();
function onlineEmails() {
  const cutoff = Date.now() - 20000;
  return Array.from(presence.entries()).filter(([, t]) => t > cutoff).map(([email]) => email);
}

function publicMembers() {
  return Object.values(db.data.users)
    .filter((u) => u.nickname)
    .map((u) => {
      const ids = (u.roles || []).filter((id) => db.data.roles[id]);
      if (config.CHIEF_EMAILS.includes(u.email) && !ids.includes(perms.CHIEF_ID)) ids.push(perms.CHIEF_ID);
      return { email: u.email, nickname: u.nickname, picture: u.picture || '', roleIds: ids, envChief: config.CHIEF_EMAILS.includes(u.email) };
    });
}

let editing = null;

function publicRoles() {
  return Object.values(db.data.roles).map((r) => ({ id: r.id, name: r.name, color: r.color, builtin: !!r.builtin, permissions: r.permissions }));
}

app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json(Object.assign({ email: u.email, name: u.name, picture: u.picture, nickname: u.nickname }, accessInfo(req.ctx)));
});

app.put('/api/me/nickname', requireAuth, express.json({ limit: '10kb' }), (req, res) => {
  const nickname = cleanNickname(req.body && req.body.nickname);
  if (!nickname) return res.status(400).json({ error: 'Please choose a nickname between 2 and 40 characters.' });
  db.setNickname(req.user.email, nickname);
  res.json({ nickname });
});

app.get('/api/state', requireNickname, (req, res) => {
  const since = Number(req.query.since) || 0;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 1000);
  const rev = db.data.rev;
  const live = { online: onlineEmails(), editing: editing ? editing.activeLocks() : {}, chatRev: db.data.chatRev || 0 };
  if (since === rev) return res.json(Object.assign({ rev, unchanged: true }, live));
  const activity = db.data.activity.slice(-limit).reverse();
  res.json({
    rev,
    ...live,
    members: publicMembers(),
    files: req.ctx.perms.view ? Object.values(db.data.files).map((f) => publicFile(f, req.ctx)) : [],
    roles: publicRoles(),
    access: accessInfo(req.ctx),
    activity,
    totalActivity: db.data.activity.length,
  });
});

app.get('/api/activity.csv', requireNickname, (req, res) => {
  const rows = [['Date and time (UTC)', 'Nickname', 'Email', 'Action', 'File', 'Details']];
  for (const a of db.data.activity.slice().reverse()) rows.push([a.ts, a.nickname, a.email, a.action, a.file, a.detail || '']);
  const body = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition('attachment', 'zarzis-portes-activity.csv'));
  res.send(body);
});

// Download or preview
app.get('/api/files/:name/content', requireNickname, (req, res) => {
  const entry = db.getFile(req.params.name);
  if (!entry) return res.status(404).json({ error: 'File not found.' });
  const full = path.join(config.FILES_DIR, entry.name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File is missing on the server.' });

  const inlineType = req.query.download === '1' ? null : inlineTypeFor(entry.name);
  if (inlineType ? !req.ctx.perms.view : !req.ctx.perms.download) {
    return res.status(403).json({ error: inlineType ? 'Your role is not allowed to view files.' : 'Your role is not allowed to download files.' });
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', inlineType || 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(inlineType ? 'inline' : 'attachment', entry.name));
  res.sendFile(full, { dotfiles: 'allow', cacheControl: false }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).json({ error: 'Could not read the file.' });
  });
});

function uploadDenial(ctx, name) {
  const existing = db.getFile(name);
  if (existing) {
    return perms.canModify(ctx, existing, 'edit')
      ? null
      : existing.editRoles && existing.editRoles.length
        ? '“' + existing.name + '” is protected: only ' + existing.editRoles.map((id) => (db.data.roles[id] || {}).name).filter(Boolean).join(', ') + ' (and the Chief) can replace it.'
        : 'Your role is not allowed to replace existing files.';
  }
  return perms.canUpload(ctx) ? null : 'Your role is not allowed to add new files.';
}

function denyAfterDrain(req, res, message) {
  let sent = false;
  const send = () => { if (!sent && !res.headersSent) { sent = true; res.status(403).json({ error: message }); } };
  req.on('end', send);
  req.on('error', () => {});
  req.resume();
}

// Upload (new file or overwrite). The browser sends the raw file as the request
// body and the name in the X-Filename header.
app.post('/api/upload', requireNickname, async (req, res) => {
  let name;
  try {
    name = sanitizeFileName(decodeURIComponent(String(req.headers['x-filename'] || '')));
  } catch (_) {
    name = null;
  }
  if (!name) return res.status(400).json({ error: 'That file name cannot be used.' });

  // Permission check before we accept the data (the body is read and dropped
  // first so the browser can show the message instead of a dropped connection).
  const denial = uploadDenial(req.ctx, name);
  if (denial) return denyAfterDrain(req, res, denial);

  const declared = Number(req.headers['content-length']);
  if (declared > config.MAX_UPLOAD_BYTES) {
    res.setHeader('Connection', 'close');
    return res.status(413).json({ error: 'File is too large (limit ' + Math.round(config.MAX_UPLOAD_BYTES / 1048576) + ' MB).' });
  }

  const tmp = path.join(config.TMP_DIR, crypto.randomUUID() + '.part');
  let size = 0;
  const limiter = new Transform({
    transform(chunk, enc, cb) {
      size += chunk.length;
      if (size > config.MAX_UPLOAD_BYTES) {
        const err = new Error('too large');
        err.code = 'TOO_LARGE';
        return cb(err);
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(req, limiter, fs.createWriteStream(tmp));
  } catch (err) {
    fsp.unlink(tmp).catch(() => {});
    if (err.code === 'TOO_LARGE') return res.status(413).json({ error: 'File is too large.' });
    if (!res.headersSent) return res.status(500).json({ error: 'Upload was interrupted. Please try again.' });
    return;
  }

  try {
    const result = await withLock(async () => {
      const existing = db.getFile(name);
      const denied = uploadDenial(req.ctx, name);
      if (denied) { const e = new Error(denied); e.denied = true; throw e; }
      return installFile({ user: req.user, name, tmpPath: tmp, size, existing, inApp: false });
    });
    res.json(result);
  } catch (err) {
    fsp.unlink(tmp).catch(() => {});
    if (err.denied) return res.status(403).json({ error: err.message });
    console.error('Upload failed:', err);
    res.status(500).json({ error: 'The server could not save the file.' });
  }
});

app.delete('/api/files/:name', requireNickname, async (req, res) => {
  try {
    const result = await withLock(async () => {
      const entry = db.getFile(req.params.name);
      if (!entry) return null;
      if (!perms.canModify(req.ctx, entry, 'delete')) return { denied: true };
      const full = path.join(config.FILES_DIR, entry.name);
      if (fs.existsSync(full)) {
        const dest = path.join(config.TRASH_DIR, stamp() + '__deleted__' + entry.name);
        await moveReplacing(full, dest);
        await touchNow(dest);
      }
      db.removeFile(entry.name);
      db.addActivity({
        email: req.user.email,
        nickname: req.user.nickname,
        action: 'Deleted',
        file: entry.name,
        size: entry.size,
      });
      db.commit();
      return { name: entry.name };
    });
    if (!result) return res.status(404).json({ error: 'File not found (someone may have already deleted it).' });
    if (result.denied) return res.status(403).json({ error: 'Your role is not allowed to delete this file.' });
    res.json(result);
  } catch (err) {
    console.error('Delete failed:', err);
    res.status(500).json({ error: 'The server could not delete the file.' });
  }
});


// ----------------------------------------------------------------- chat
// A small room chat. Messages are kept in the database (newest 300). Chat does
// not touch the file/Scoreboard revision, so it never reloads the whole page state.
const CHAT_KEEP = 300;
const chatRate = new Map(); // email -> timestamps of recent messages

app.get('/api/chat', requireNickname, (req, res) => {
  const list = db.data.chat || [];
  res.json({ rev: db.data.chatRev || 0, messages: list.slice(-100), canModerate: req.ctx.chief });
});

app.post('/api/chat', requireNickname, express.json({ limit: '10kb' }), (req, res) => {
  const text = String((req.body && req.body.text) || '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!text) return res.status(400).json({ error: 'Type a message first.' });
  if (text.length > 1000) return res.status(400).json({ error: 'Messages can have at most 1000 characters.' });
  const now = Date.now();
  const recent = (chatRate.get(req.user.email) || []).filter((t) => now - t < 60000);
  if (recent.length >= 20) return res.status(429).json({ error: 'You are sending messages very fast. Wait a moment.' });
  recent.push(now);
  chatRate.set(req.user.email, recent);

  db.data.chat = db.data.chat || [];
  db.data.nextChatId = db.data.nextChatId || 1;
  const msg = { id: db.data.nextChatId++, ts: new Date(now).toISOString(), email: req.user.email, nickname: req.user.nickname, text };
  db.data.chat.push(msg);
  if (db.data.chat.length > CHAT_KEEP) db.data.chat.splice(0, db.data.chat.length - CHAT_KEEP);
  db.data.chatRev = (db.data.chatRev || 0) + 1;
  db.save();
  res.json({ id: msg.id, rev: db.data.chatRev });
});

app.delete('/api/chat/:id', requireNickname, (req, res) => {
  const id = Number(req.params.id);
  const list = db.data.chat || [];
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Message not found.' });
  if (!req.ctx.chief && list[idx].email !== req.user.email) return res.status(403).json({ error: 'You can only delete your own messages.' });
  list.splice(idx, 1);
  db.data.chatRev = (db.data.chatRev || 0) + 1;
  db.save();
  res.json({ ok: true });
});


// --------------------------------------------------------------- rename
app.put('/api/files/:name/rename', requireNickname, express.json({ limit: '10kb' }), async (req, res) => {
  try {
    const result = await withLock(async () => {
      const entry = db.getFile(req.params.name);
      if (!entry) return { status: 404, error: 'File not found (someone may have deleted it).' };
      if (!perms.canModify(req.ctx, entry, 'edit')) {
        const names = (entry.editRoles || []).map((id) => (db.data.roles[id] || {}).name).filter(Boolean);
        return { status: 403, error: names.length ? 'Only ' + names.join(', ') + ' (and the Chief) can rename this file.' : 'Your role is not allowed to modify files, so it cannot rename them either.' };
      }
      let next = sanitizeFileName(req.body && req.body.name);
      if (!next) return { status: 400, error: 'Please type a new name.' };
      const oldExt = path.extname(entry.name);
      if (!path.extname(next) && oldExt) next += oldExt; // “Budget” stays “Budget.xlsx”
      if (next === entry.name) return { status: 400, error: 'That is already the name of the file.' };
      const clash = db.getFile(next);
      if (clash && db.fileKey(clash.name) !== db.fileKey(entry.name)) return { status: 409, error: '“' + clash.name + '” already exists. Choose another name.' };
      const lock = editing && editing.activeLocks()[entry.name];
      if (lock && lock.email !== req.user.email) return { status: 409, error: lock.by + ' is editing this file right now. Try again in a moment.' };

      const from = path.join(config.FILES_DIR, entry.name);
      const to = path.join(config.FILES_DIR, next);
      if (fs.existsSync(from)) {
        if (db.fileKey(next) === db.fileKey(entry.name)) {
          // only the capital letters change: go through a temporary name so Windows/macOS accept it
          const mid = path.join(config.TMP_DIR, crypto.randomUUID() + '.rename');
          await moveReplacing(from, mid);
          await moveReplacing(mid, to);
        } else {
          await moveReplacing(from, to);
        }
      }
      const old = entry.name;
      db.removeFile(old);
      db.putFile(Object.assign({}, entry, { name: next }));
      if (editing) editing.dropLock(old);
      db.addActivity({ email: req.user.email, nickname: req.user.nickname, action: 'Renamed', file: next, size: entry.size, detail: 'Was “' + old + '”' });
      db.commit();
      return { name: next, was: old };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error('Rename failed:', err);
    res.status(500).json({ error: 'The server could not rename the file.' });
  }
});

// ---------------------------------------------------------------- trash
// Everything removed or overwritten is kept in data/trash as
//   <time>__<deleted|replaced|edited>__<original name>
// Anyone who may delete files (and the Chief) can look through it and restore.
const TRASH_RE = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)__(deleted|replaced|edited)__(.+)$/;
const REASON_TEXT = { deleted: 'Deleted file', replaced: 'Older version (replaced by upload)', edited: 'Older version (before an edit)' };

function canSeeTrash(ctx) {
  return ctx.chief || !!ctx.perms.delete;
}

function parseTrash(id) {
  if (id !== path.basename(id)) return null;
  const m = TRASH_RE.exec(id);
  if (!m) return null;
  const iso = m[1].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/, 'T$1:$2:$3.$4Z');
  return { id, ts: iso, reason: m[2], name: m[3] };
}

app.get('/api/trash', requireNickname, async (req, res) => {
  if (!canSeeTrash(req.ctx)) return res.status(403).json({ error: 'Your role is not allowed to open the trash.' });
  try {
    const items = [];
    for (const f of await fsp.readdir(config.TRASH_DIR)) {
      const info = parseTrash(f);
      if (!info) continue;
      const st = await fsp.stat(path.join(config.TRASH_DIR, f)).catch(() => null);
      if (!st || !st.isFile()) continue;
      let by = null;
      if (info.reason === 'deleted') {
        const t = Date.parse(info.ts);
        const hit = db.data.activity.filter((a) => a.action === 'Deleted' && a.file === info.name && Date.parse(a.ts) <= t + 5000).pop();
        if (hit) by = hit.nickname || hit.email;
      }
      items.push({ id: f, name: info.name, reason: info.reason, reasonText: REASON_TEXT[info.reason], ts: info.ts, size: st.size, by, nameTaken: !!db.getFile(info.name) });
    }
    items.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    res.json({ items: items.slice(0, 500), total: items.length, days: config.TRASH_DAYS, canPurge: req.ctx.chief });
  } catch (err) {
    console.error('Trash list failed:', err);
    res.status(500).json({ error: 'The trash could not be read.' });
  }
});

app.post('/api/trash/restore', requireNickname, express.json({ limit: '10kb' }), async (req, res) => {
  if (!canSeeTrash(req.ctx)) return res.status(403).json({ error: 'Your role is not allowed to restore files.' });
  const info = parseTrash(String((req.body && req.body.id) || ''));
  if (!info) return res.status(400).json({ error: 'Unknown trash item.' });
  const src = path.join(config.TRASH_DIR, info.id);
  try {
    const result = await withLock(async () => {
      if (!fs.existsSync(src)) return { status: 404, error: 'This item is no longer in the trash.' };
      let existing = db.getFile(info.name);
      let name = info.name;
      let label;
      if (info.reason === 'deleted') {
        // Never overwrite a file that is there now: restore next to it under a new name.
        if (existing) {
          const ext = path.extname(name);
          const base = name.slice(0, name.length - ext.length);
          let n = 1;
          do { name = base + ' (restored' + (n > 1 ? ' ' + n : '') + ')' + ext; n++; } while (db.getFile(name));
          existing = null;
        }
        label = { action: 'Restored', detail: 'Brought back from the trash' + (name !== info.name ? ' as “' + name + '”' : '') };
      } else {
        if (existing && !perms.canModify(req.ctx, existing, 'edit')) return { status: 403, error: 'Your role is not allowed to modify “' + existing.name + '”.' };
        label = { action: 'Restored', detail: 'Went back to the version from ' + info.ts.replace('T', ' ').slice(0, 16) + ' UTC' + (existing ? ' (the version before is kept in the trash)' : '') };
      }
      if (existing) name = existing.name;
      const tmp = path.join(config.TMP_DIR, crypto.randomUUID() + '.part');
      await fsp.copyFile(src, tmp);
      const size = (await fsp.stat(tmp)).size;
      try {
        await installFile({ user: req.user, name, tmpPath: tmp, size, existing, inApp: false, label });
      } catch (e) {
        fsp.unlink(tmp).catch(() => {});
        throw e;
      }
      await fsp.unlink(src).catch(() => {});
      return { name };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error('Restore failed:', err);
    res.status(500).json({ error: 'The file could not be restored.' });
  }
});

app.delete('/api/trash/:id', requireNickname, async (req, res) => {
  if (!req.ctx.chief) return res.status(403).json({ error: 'Only the Chief can empty the trash.' });
  const info = parseTrash(req.params.id);
  if (!info) return res.status(400).json({ error: 'Unknown trash item.' });
  try {
    await withLock(async () => {
      await fsp.unlink(path.join(config.TRASH_DIR, info.id)).catch(() => {});
      db.addActivity({ email: req.user.email, nickname: req.user.nickname, action: 'Deleted', file: info.name, detail: 'Removed from the trash for good' });
      db.commit();
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Purge failed:', err);
    res.status(500).json({ error: 'Could not remove it.' });
  }
});


editing = editRoutes.register({ app, config, db, requireNickname, withLock, installFile });

// ------------------------------------------------------- roles (Chief only)
const jsonBody = express.json({ limit: '20kb' });

function logAccess(req, detail, file) {
  db.addActivity({ email: req.user.email, nickname: req.user.nickname, action: 'Access changed', file: file || '', detail });
  db.commit();
}

function readRoleFields(body, existing) {
  const name = String((body && body.name) == null ? (existing ? existing.name : '') : body.name).replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 30) return { error: 'Role names must be 2 to 30 characters.' };
  const clash = Object.values(db.data.roles).find((r) => r.name.toLowerCase() === name.toLowerCase() && (!existing || r.id !== existing.id));
  if (clash) return { error: 'There is already a role called “' + clash.name + '”.' };
  const color = /^#[0-9a-f]{6}$/i.test((body && body.color) || '') ? body.color : existing ? existing.color : '#1d4f91';
  const permissions = perms.cleanPermissions(body && body.permissions);
  return { name, color, permissions };
}

app.get('/api/admin/members', requireChief, (req, res) => {
  const members = Object.values(db.data.users).map((u) => ({
    email: u.email,
    name: u.name,
    nickname: u.nickname,
    picture: u.picture,
    lastLogin: u.lastLogin,
    roles: (u.roles || []).filter((id) => db.data.roles[id]),
    chiefByConfig: config.CHIEF_EMAILS.includes(u.email),
  }));
  members.sort((a, b) => (a.nickname || a.email).toLowerCase().localeCompare((b.nickname || b.email).toLowerCase()));
  res.json({ members, roles: publicRoles() });
});

app.post('/api/admin/roles', requireChief, jsonBody, (req, res) => {
  const f = readRoleFields(req.body, null);
  if (f.error) return res.status(400).json({ error: f.error });
  const id = 'r_' + crypto.randomBytes(4).toString('hex');
  db.data.roles[id] = { id, name: f.name, color: f.color, builtin: false, permissions: f.permissions };
  logAccess(req, 'Created role “' + f.name + '”');
  res.json({ id });
});

app.put('/api/admin/roles/:id', requireChief, jsonBody, (req, res) => {
  const role = db.data.roles[req.params.id];
  if (!role) return res.status(404).json({ error: 'Role not found.' });
  if (role.id === perms.CHIEF_ID) return res.status(400).json({ error: 'The Chief role always has every permission.' });
  if (role.id === perms.MEMBER_ID) {
    role.permissions = perms.cleanPermissions(req.body && req.body.permissions);
  } else {
    const f = readRoleFields(req.body, role);
    if (f.error) return res.status(400).json({ error: f.error });
    Object.assign(role, { name: f.name, color: f.color, permissions: f.permissions });
  }
  const on = perms.PERMISSIONS.filter((p) => role.permissions[p]).join(', ') || 'view only';
  logAccess(req, 'Role “' + role.name + '” now: ' + on);
  res.json({ ok: true });
});

app.delete('/api/admin/roles/:id', requireChief, (req, res) => {
  const role = db.data.roles[req.params.id];
  if (!role) return res.status(404).json({ error: 'Role not found.' });
  if (role.builtin) return res.status(400).json({ error: 'Built-in roles cannot be deleted.' });
  delete db.data.roles[role.id];
  for (const u of Object.values(db.data.users)) u.roles = (u.roles || []).filter((id) => id !== role.id);
  for (const f of Object.values(db.data.files)) f.editRoles = (f.editRoles || []).filter((id) => id !== role.id);
  logAccess(req, 'Deleted role “' + role.name + '”');
  res.json({ ok: true });
});

app.put('/api/admin/members/:email/roles', requireChief, jsonBody, (req, res) => {
  const user = db.getUser(req.params.email);
  if (!user) return res.status(404).json({ error: 'Person not found.' });
  const wanted = Array.from(new Set((req.body && req.body.roles) || [])).filter((id) => db.data.roles[id] && id !== perms.MEMBER_ID);
  const before = user.roles || [];

  // Never leave the room without a Chief.
  if (before.includes(perms.CHIEF_ID) && !wanted.includes(perms.CHIEF_ID) && !config.CHIEF_EMAILS.length) {
    const others = Object.values(db.data.users).filter((u) => u.email !== user.email && (u.roles || []).includes(perms.CHIEF_ID));
    if (!others.length) return res.status(400).json({ error: 'There must be at least one Chief. Make someone else Chief first.' });
  }

  user.roles = wanted;
  const names = (ids) => ids.map((id) => db.data.roles[id].name);
  const added = names(wanted.filter((id) => !before.includes(id)));
  const removed = names(before.filter((id) => !wanted.includes(id) && db.data.roles[id]));
  const bits = [];
  if (added.length) bits.push('added ' + added.join(', '));
  if (removed.length) bits.push('removed ' + removed.join(', '));
  if (bits.length) logAccess(req, (user.nickname || user.email) + ' (' + user.email + '): ' + bits.join('; '));
  res.json({ roles: user.roles });
});

app.put('/api/files/:name/access', requireChief, jsonBody, (req, res) => {
  const entry = db.getFile(req.params.name);
  if (!entry) return res.status(404).json({ error: 'File not found.' });
  const wanted = Array.from(new Set((req.body && req.body.editRoles) || [])).filter(
    (id) => db.data.roles[id] && id !== perms.MEMBER_ID && id !== perms.CHIEF_ID
  );
  entry.editRoles = wanted;
  const text = wanted.length
    ? 'Only ' + wanted.map((id) => db.data.roles[id].name).join(', ') + ' (and the Chief) can now replace or delete this file'
    : 'Restriction removed: general permissions apply again';
  logAccess(req, text, entry.name);
  res.json({ editRoles: wanted });
});

// ----------------------------------------------------------- static pages
app.use(
  express.static(config.PUBLIC_DIR, {
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.status(404).send('Page not found'));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// ------------------------------------------------------------------ HTTPS
function getTlsCredentials() {
  if (config.SSL_KEY_FILE && config.SSL_CERT_FILE) {
    return { key: fs.readFileSync(config.SSL_KEY_FILE), cert: fs.readFileSync(config.SSL_CERT_FILE) };
  }
  const keyFile = path.join(config.CERT_DIR, 'server.key');
  const certFile = path.join(config.CERT_DIR, 'server.crt');
  const metaFile = path.join(config.CERT_DIR, 'server.names.txt');

  const dnsNames = Array.from(new Set([config.BASE_HOSTNAME, 'localhost'])).filter((n) => !/^\d+\.\d+\.\d+\.\d+$/.test(n));
  const ips = Array.from(new Set(['127.0.0.1', ...config.lanAddresses(), /^\d+\.\d+\.\d+\.\d+$/.test(config.BASE_HOSTNAME) ? config.BASE_HOSTNAME : null].filter(Boolean)));
  const fingerprint = JSON.stringify({ dnsNames, ips });

  const upToDate =
    fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.existsSync(metaFile) && fs.readFileSync(metaFile, 'utf8') === fingerprint;
  if (!upToDate) {
    const selfsigned = require('selfsigned');
    const altNames = [
      ...dnsNames.map((value) => ({ type: 2, value })),
      ...ips.map((ip) => ({ type: 7, ip })),
    ];
    const pems = selfsigned.generate([{ name: 'commonName', value: config.BASE_HOSTNAME }], {
      days: 825,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    });
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(metaFile, fingerprint);
    console.log('Created a new security certificate for', dnsNames.join(', '));
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

function start() {
  const server = config.USE_HTTPS ? https.createServer(getTlsCredentials(), app) : http.createServer(app);
  server.requestTimeout = 0; // big uploads over a slow network are fine
  server.headersTimeout = 60000;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error('\nPort ' + config.PORT + ' is already in use. Is the server already running? Close it, or change PORT in .env.\n');
    else if (err.code === 'EACCES') console.error('\nNot allowed to use port ' + config.PORT + '. Use a port above 1024 (e.g. 3443) in BASE_URL.\n');
    else console.error(err);
    process.exit(1);
  });

  server.listen(config.PORT, '0.0.0.0', () => {
    const line = '='.repeat(64);
    console.log('\n' + line);
    console.log(' Zarzis Portes - Shared Room is running');
    console.log(line);
    console.log(' Staff address (share this one):  ' + config.BASE_URL);
    console.log(' Google redirect URI to register: ' + config.REDIRECT_URI);
    console.log(' This computer\'s network address: ' + (config.lanAddresses().join(', ') || '(none found)'));
    console.log(' Files are stored in:             ' + config.FILES_DIR);
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
      console.log('\n !! GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing in .env - sign-in will not work.');
    }
    if (!config.ALLOWED_EMAILS.length && !config.ALLOWED_DOMAINS.length) {
      console.log('\n !! ALLOWED_EMAILS is empty: ANY Google account that can reach this PC may sign in.');
    }
    console.log(line + '\n');
  });

  purgeTrash().catch(() => {});
  setInterval(() => purgeTrash().catch(() => {}), 24 * 3600 * 1000).unref();
}

if (require.main === module) start();

module.exports = { app, db };
