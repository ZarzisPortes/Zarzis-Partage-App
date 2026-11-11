'use strict';

// In-app editing: text files, Word (.docx) and Excel (.xlsx) workbooks.
//
//  * Text and Word: one editor at a time (a "lock" that is refreshed while the
//    editor is open and expires by itself if the browser closes).
//  * Excel: several people can edit at once. Only the changed cells are saved,
//    straight into the current file, so different people's cells never collide.

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const xlsx = require('./xlsx');
const docx = require('./docx');
const perms = require('./permissions');
const { sanitizeFileName } = require('./util');

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml', '.ini']);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_OFFICE_BYTES = 40 * 1024 * 1024;
const LOCK_MS = 90 * 1000;

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXT.has(ext)) return 'text';
  if (ext === '.docx' || ext === '.docm') return 'docx';
  if (ext === '.xlsx' || ext === '.xlsm') return 'sheet';
  return null;
}

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

function register({ app, config, db, requireNickname, withLock, installFile }) {
  const json = express.json({ limit: '4mb' });
  const locks = new Map(); // lower-case file name -> { email, nickname, expires }

  function lockFor(key) {
    const l = locks.get(key);
    if (l && l.expires < Date.now()) {
      locks.delete(key);
      return null;
    }
    return l || null;
  }

  function activeLocks() {
    const out = {};
    for (const key of Array.from(locks.keys())) {
      const l = lockFor(key);
      if (l && db.data.files[key]) out[db.data.files[key].name] = { by: l.nickname, email: l.email };
    }
    return out;
  }

  function wrap(fn) {
    return async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof HttpError) return res.status(err.status).json(Object.assign({ error: err.message }, err.extra));
        console.error('Edit error:', err);
        res.status(422).json({ error: err.message || 'The file could not be processed.' });
      }
    };
  }

  function target(req, expectedKind) {
    const entry = db.getFile(req.params.name);
    if (!entry) throw new HttpError(404, 'File not found.');
    const kind = kindOf(entry.name);
    if (!kind || (expectedKind && kind !== expectedKind)) throw new HttpError(400, 'This kind of file cannot be edited in the app.');
    if (!req.ctx.perms.view) throw new HttpError(403, 'Your role is not allowed to view files.');
    return { entry, kind, key: db.fileKey(entry.name), full: path.join(config.FILES_DIR, entry.name) };
  }

  function needEdit(req, entry) {
    if (!perms.canModify(req.ctx, entry, 'edit')) {
      const names = (entry.editRoles || []).map((id) => (db.data.roles[id] || {}).name).filter(Boolean);
      throw new HttpError(
        403,
        names.length ? 'Only ' + names.join(', ') + ' (and the Chief) can edit this file.' : 'Your role is not allowed to modify files.'
      );
    }
  }

  function needLockFree(req, key) {
    const l = lockFor(key);
    if (l && l.email !== req.user.email) throw new HttpError(409, l.nickname + ' is editing this file right now.', { by: l.nickname });
  }

  // Applies a change to the CURRENT file on disk and installs it as a new version.
  async function save(req, name, baseVersion, makeBuffer) {
    return withLock(async () => {
      const entry = db.getFile(name);
      if (!entry) throw new HttpError(404, 'File not found (it may have been deleted).');
      needEdit(req, entry);
      if (baseVersion != null && entry.version !== baseVersion) {
        throw new HttpError(409, 'Someone replaced this file while you were editing. Reload to see the latest version.', { changed: true });
      }
      const current = await fsp.readFile(path.join(config.FILES_DIR, entry.name));
      const made = await makeBuffer(current);
      const buffer = Buffer.isBuffer(made) ? made : made.buffer;
      const tmp = path.join(config.TMP_DIR, crypto.randomUUID() + '.part');
      await fsp.writeFile(tmp, buffer);
      try {
        const r = await installFile({ user: req.user, name: entry.name, tmpPath: tmp, size: buffer.length, existing: entry, inApp: true });
        return { version: r.version, skipped: Buffer.isBuffer(made) ? [] : made.skipped || [] };
      } catch (e) {
        fsp.unlink(tmp).catch(() => {});
        throw e;
      }
    });
  }

  // ------------------------------------------------------------- open
  app.get('/api/edit/:name', requireNickname, wrap(async (req, res) => {
    const t = target(req);
    const stat = await fsp.stat(t.full).catch(() => null);
    if (!stat) throw new HttpError(404, 'The file is missing on the server.');
    if (stat.size > (t.kind === 'text' ? MAX_TEXT_BYTES : MAX_OFFICE_BYTES)) {
      throw new HttpError(413, 'This file is too large to edit in the app. Download it instead.');
    }
    const buf = await fsp.readFile(t.full);
    const out = { name: t.entry.name, kind: t.kind, version: t.entry.version, canEdit: perms.canModify(req.ctx, t.entry, 'edit') };

    if (t.kind === 'text') {
      if (buf.includes(0)) throw new HttpError(415, 'This does not look like a text file.');
      let text = buf.toString('utf8');
      out.bom = text.charCodeAt(0) === 0xfeff;
      if (out.bom) text = text.slice(1);
      out.text = text;
    } else if (t.kind === 'docx') {
      out.paragraphs = await docx.readParagraphs(buf);
    } else {
      out.workbook = await xlsx.readWorkbook(buf);
    }
    if (t.kind !== 'sheet') {
      const l = lockFor(t.key);
      out.lock = l ? { by: l.nickname, mine: l.email === req.user.email } : null;
    }
    res.set('Cache-Control', 'no-store').json(out);
  }));

  // ------------------------------------------------------------ locks
  app.post('/api/edit/:name/lock', requireNickname, wrap(async (req, res) => {
    const t = target(req);
    if (t.kind === 'sheet') return res.json({ ok: true });
    needEdit(req, t.entry);
    needLockFree(req, t.key);
    locks.set(t.key, { email: req.user.email, nickname: req.user.nickname, expires: Date.now() + LOCK_MS });
    res.json({ ok: true });
  }));

  app.delete('/api/edit/:name/lock', requireNickname, wrap(async (req, res) => {
    const entry = db.getFile(req.params.name);
    if (entry) {
      const key = db.fileKey(entry.name);
      const l = lockFor(key);
      if (l && l.email === req.user.email) locks.delete(key);
    }
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------- save
  app.put('/api/edit/:name/text', requireNickname, json, wrap(async (req, res) => {
    const t = target(req, 'text');
    needEdit(req, t.entry);
    needLockFree(req, t.key);
    const { text, baseVersion, bom } = req.body || {};
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new HttpError(400, 'The text is missing or too large.');
    const out = await save(req, t.entry.name, baseVersion, () => Buffer.from((bom ? '﻿' : '') + text, 'utf8'));
    locks.set(t.key, { email: req.user.email, nickname: req.user.nickname, expires: Date.now() + LOCK_MS });
    res.json(out);
  }));

  app.put('/api/edit/:name/docx', requireNickname, json, wrap(async (req, res) => {
    const t = target(req, 'docx');
    needEdit(req, t.entry);
    needLockFree(req, t.key);
    const { items, baseVersion } = req.body || {};
    if (!Array.isArray(items) || items.length > 20000) throw new HttpError(400, 'Nothing to save.');
    const clean = items.map((it) => ({ i: Number.isInteger(it && it.i) ? it.i : null, text: typeof (it && it.text) === 'string' ? it.text : '' }));
    const out = await save(req, t.entry.name, baseVersion, async (current) => {
      try {
        return await docx.applyItems(current, clean);
      } catch (e) {
        throw new HttpError(409, e.message, { changed: /changed/.test(e.message) });
      }
    });
    locks.set(t.key, { email: req.user.email, nickname: req.user.nickname, expires: Date.now() + LOCK_MS });
    res.json(out);
  }));

  app.patch('/api/edit/:name/cells', requireNickname, json, wrap(async (req, res) => {
    const t = target(req, 'sheet');
    needEdit(req, t.entry);
    const list = (req.body && req.body.changes) || [];
    if (!Array.isArray(list) || !list.length || list.length > 5000) throw new HttpError(400, 'Nothing to save.');
    const changes = list.map((c) => {
      const ok =
        c && typeof c.sheet === 'string' && Number.isInteger(c.r) && c.r >= 1 && c.r <= 1048576 && Number.isInteger(c.c) && c.c >= 1 && c.c <= 16384;
      const v = c ? c.v : null;
      const vOk = v === null || ['number', 'string', 'boolean'].includes(typeof v);
      if (!ok || !vOk || (typeof v === 'string' && v.length > 32000) || (c.f != null && (typeof c.f !== 'string' || c.f.length > 8000))) {
        throw new HttpError(400, 'One of the changes is not valid.');
      }
      return { sheet: c.sheet, r: c.r, c: c.c, v: typeof v === 'number' && !Number.isFinite(v) ? null : v, f: c.f || null };
    });
    const out = await save(req, t.entry.name, null, (current) => xlsx.applyChanges(current, changes));
    res.json(out);
  }));

  app.post('/api/edit/:name/sheets', requireNickname, json, wrap(async (req, res) => {
    const t = target(req, 'sheet');
    needEdit(req, t.entry);
    let added = null;
    const out = await save(req, t.entry.name, null, async (current) => {
      try {
        const r = await xlsx.addSheet(current, req.body && req.body.name);
        added = r.name;
        return r.buffer;
      } catch (e) {
        throw new HttpError(400, e.message);
      }
    });
    res.json({ version: out.version, name: added });
  }));

  // ----------------------------------------------------------- new file
  app.post('/api/new', requireNickname, json, wrap(async (req, res) => {
    if (!perms.canUpload(req.ctx)) throw new HttpError(403, 'Your role is not allowed to add new files.');
    const kind = req.body && req.body.kind;
    const ext = { text: '.txt', docx: '.docx', sheet: '.xlsx' }[kind];
    if (!ext) throw new HttpError(400, 'Choose what kind of file to create.');
    let name = sanitizeFileName(req.body.name);
    if (!name) throw new HttpError(400, 'Please type a file name.');
    if (kindOf(name) !== kind) name += ext;

    const out = await withLock(async () => {
      if (db.getFile(name)) throw new HttpError(409, '“' + name + '” already exists. Choose another name.');
      const buffer = kind === 'sheet' ? await xlsx.blankWorkbook() : kind === 'docx' ? await docx.blankDocument() : Buffer.alloc(0);
      const tmp = path.join(config.TMP_DIR, crypto.randomUUID() + '.part');
      await fsp.writeFile(tmp, buffer);
      try {
        return await installFile({ user: req.user, name, tmpPath: tmp, size: buffer.length, existing: null, inApp: true });
      } catch (e) {
        fsp.unlink(tmp).catch(() => {});
        throw e;
      }
    });
    res.json({ name: out.name });
  }));

  function dropLock(name) { locks.delete(db.fileKey(name)); }

  return { activeLocks, dropLock };
}

module.exports = { register, kindOf };
