'use strict';
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const BASE_URL = process.env.BASE_URL || 'https://localhost:3443';
const parsedUrl = new URL(BASE_URL);

module.exports = {
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : (parsedUrl.port ? parseInt(parsedUrl.port, 10) : (parsedUrl.protocol === 'https:' ? 3443 : 3000)),
  BASE_URL,
  BASE_HOSTNAME: parsedUrl.hostname,
  BASE_HOST: parsedUrl.host,
  SERVE_TLS: parsedUrl.protocol === 'https:' && !process.env.BEHIND_PROXY,
  BEHIND_PROXY: !!process.env.BEHIND_PROXY || process.env.RENDER || parsedUrl.protocol !== 'https:',
  USE_HTTPS: parsedUrl.protocol === 'https:' || !!process.env.RENDER,
  REDIRECT_URI: BASE_URL.replace(/\/+$/, '') + '/auth/google/callback',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  ALLOWED_EMAILS: (process.env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  ALLOWED_DOMAINS: (process.env.ALLOWED_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  CHIEF_EMAILS: (process.env.CHIEF_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  STAFF_PASSWORD: process.env.STAFF_PASSWORD || '',
  MAX_UPLOAD_BYTES: (parseInt(process.env.MAX_UPLOAD_MB, 10) || 200) * 1024 * 1024,
  TRASH_DAYS: process.env.TRASH_DAYS !== undefined ? parseInt(process.env.TRASH_DAYS, 10) : 30,
  DATA_DIR,
  FILES_DIR: path.join(DATA_DIR, 'shared-files'),
  TRASH_DIR: path.join(DATA_DIR, 'trash'),
  TMP_DIR: path.join(DATA_DIR, 'tmp'),
  CERT_DIR: path.join(DATA_DIR, 'certs'),
  DB_FILE: path.join(DATA_DIR, 'db.json'),
  SECRET_FILE: path.join(DATA_DIR, 'session-secret.txt'),
  SSL_KEY_FILE: process.env.SSL_KEY_FILE || '',
  SSL_CERT_FILE: process.env.SSL_CERT_FILE || '',
  lanAddresses() {
    const list = [];
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets || []) {
        if (net.family === 'IPv4' && !net.internal) list.push(net.address);
      }
    }
    return list;
  }
};
