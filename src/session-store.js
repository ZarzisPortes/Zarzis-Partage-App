'use strict';
/*
 * Sessions kept in a JSON file, so staff stay signed in when the server
 * PC is restarted (the default in-memory store would sign everybody out).
 */

const fs = require('fs');
const session = require('express-session');

class FileSessionStore extends session.Store {
  constructor(file) {
    super();
    this.file = file;
    this.sessions = {};
    this.timer = null;

    if (fs.existsSync(file)) {
      try {
        this.sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        this.sessions = {};
      }
    }
    this._purgeExpired();
    // Clean out expired sessions once an hour; unref so it never blocks shutdown.
    setInterval(() => this._purgeExpired(), 60 * 60 * 1000).unref();
  }

  _isExpired(sess) {
    const exp = sess && sess.cookie && sess.cookie.expires;
    return exp ? new Date(exp).getTime() <= Date.now() : false;
  }

  _purgeExpired() {
    let changed = false;
    for (const sid of Object.keys(this.sessions)) {
      if (this._isExpired(this.sessions[sid])) {
        delete this.sessions[sid];
        changed = true;
      }
    }
    if (changed) this._persist();
  }

  _persist() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.sessions));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.error('Could not save sessions:', err.message);
      }
    }, 300);
  }

  get(sid, cb) {
    const sess = this.sessions[sid];
    if (!sess) return cb(null, null);
    if (this._isExpired(sess)) {
      delete this.sessions[sid];
      this._persist();
      return cb(null, null);
    }
    cb(null, JSON.parse(JSON.stringify(sess)));
  }

  set(sid, sess, cb) {
    this.sessions[sid] = JSON.parse(JSON.stringify(sess));
    this._persist();
    if (cb) cb(null);
  }

  touch(sid, sess, cb) {
    if (this.sessions[sid]) {
      this.sessions[sid].cookie = JSON.parse(JSON.stringify(sess.cookie));
      this._persist();
    }
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    delete this.sessions[sid];
    this._persist();
    if (cb) cb(null);
  }
}

module.exports = FileSessionStore;
