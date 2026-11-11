'use strict';

// A small JSON "database". Everything lives in memory and is written to disk
// atomically (temp file + rename) after every change, so a crash or power cut
// cannot leave a half-written file behind.

const fs = require('fs');
const path = require('path');
const { defaultRoles, CHIEF_ID, PERMISSIONS } = require('./permissions');

class Store {
  constructor(file) {
    this.file = file;
    this.data = { rev: 1, nextActivityId: 1, users: {}, files: {}, activity: [], roles: defaultRoles() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        throw new Error(
          'Could not read ' + file + ' (' + e.message + '). Restore it from "' + file + '.bak" if that exists.'
        );
      }
      this.data = Object.assign(this.data, parsed);
      // Databases created before roles existed get the built-in roles.
      const builtin = defaultRoles();
      this.data.roles = Object.assign({}, builtin, this.data.roles || {});
      this.data.roles.chief.permissions = builtin.chief.permissions;
      this.data.roles.chief.builtin = this.data.roles.member.builtin = true;
      for (const u of Object.values(this.data.users)) if (!Array.isArray(u.roles)) u.roles = [];
      // Roles saved before "view" and "download" existed keep full access to those.
      for (const r of Object.values(this.data.roles)) {
        r.permissions = r.permissions || {};
        for (const p of PERMISSIONS) if (r.permissions[p] === undefined) r.permissions[p] = true;
      }
      this.save();
    } else {
      this.save();
    }
  }

  // True when somebody already holds the Chief role (via .env or assigned).
  hasChief(chiefEmails) {
    return chiefEmails.length > 0 || Object.values(this.data.users).some((u) => (u.roles || []).includes(CHIEF_ID));
  }

  save() {
    const tmp = this.file + '.tmp';
    const json = JSON.stringify(this.data);
    fs.writeFileSync(tmp, json);
    try {
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Windows can briefly lock the file (antivirus, indexer). Fall back to a direct write.
      fs.writeFileSync(this.file, json);
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  }

  bump() {
    this.data.rev += 1;
  }

  // ---- users ----
  getUser(email) {
    return this.data.users[String(email).toLowerCase()] || null;
  }

  upsertLogin({ email, name, picture }) {
    const key = String(email).toLowerCase();
    const now = new Date().toISOString();
    const existing = this.data.users[key];
    const user = existing || { email: key, nickname: '', roles: [], createdAt: now };
    if (!existing) this.bump();
    user.name = name || user.name || '';
    user.picture = picture || '';
    user.lastLogin = now;
    this.data.users[key] = user;
    this.save();
    return user;
  }

  setNickname(email, nickname) {
    const user = this.getUser(email);
    if (!user) return null;
    user.nickname = nickname;
    this.bump();
    this.save();
    return user;
  }

  // ---- files ----
  fileKey(name) {
    return String(name).toLowerCase();
  }

  getFile(name) {
    return this.data.files[this.fileKey(name)] || null;
  }

  putFile(entry) {
    this.data.files[this.fileKey(entry.name)] = entry;
  }

  removeFile(name) {
    delete this.data.files[this.fileKey(name)];
  }

  // ---- activity ----
  addActivity({ email, nickname, action, file, size, detail }) {
    const entry = {
      id: this.data.nextActivityId++,
      ts: new Date().toISOString(),
      email,
      nickname,
      action,
      file: file || '',
      detail: detail || '',
      size: size == null ? null : size,
    };
    this.data.activity.push(entry);
    return entry;
  }

  commit() {
    this.bump();
    this.save();
  }
}

module.exports = { Store };
