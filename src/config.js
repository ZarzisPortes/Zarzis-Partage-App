'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

// Tiny .env loader (no extra dependency). Real environment variables win.
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const BASE_URL = String(process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
let parsed;
try {
  parsed = new URL(BASE_URL);
} catch (e) {
  throw new Error('BASE_URL is not a valid address: ' + BASE_URL);
}

const useHttps = parsed.protocol === 'https:';
const defaultPort = parsed.port ? Number(parsed.port) : useHttps ? 443 : 80;
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');

const config = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR,
  FILES_DIR: path.join(DATA_DIR, 'shared-files'),
  TRASH_DIR: path.join(DATA_DIR, 'trash'),
  TMP_DIR: path.join(DATA_DIR, 'tmp'),
  CERT_DIR: path.join(DATA_DIR, 'certs'),
  DB_FILE: path.join(DATA_DIR, 'db.json'),
  SECRET_FILE: path.join(DATA_DIR, 'session-secret.txt'),

  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  BASE_URL,
  BASE_HOST: parsed.host.toLowerCase(), // includes port unless it is the default one
  BASE_HOSTNAME: parsed.hostname,
  USE_HTTPS: useHttps,
  PORT: Number(process.env.PORT) || defaultPort,
  REDIRECT_URI: BASE_URL + '/auth/google/callback',

  ALLOWED_EMAILS: list(process.env.ALLOWED_EMAILS),
  ALLOWED_DOMAINS: list(process.env.ALLOWED_DOMAINS),
  CHIEF_EMAILS: list(process.env.CHIEF_EMAILS),

  MAX_UPLOAD_BYTES: Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 200) * 1024 * 1024,
  TRASH_DAYS: process.env.TRASH_DAYS === undefined ? 30 : Math.max(0, Number(process.env.TRASH_DAYS) || 0),

  SSL_KEY_FILE: process.env.SSL_KEY_FILE || '',
  SSL_CERT_FILE: process.env.SSL_CERT_FILE || '',
};

config.lanAddresses = function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
};

config.isEmailAllowed = function isEmailAllowed(email) {
  email = String(email || '').toLowerCase();
  if (!config.ALLOWED_EMAILS.length && !config.ALLOWED_DOMAINS.length) return true;
  if (config.ALLOWED_EMAILS.includes(email)) return true;
  const domain = email.split('@')[1] || '';
  return config.ALLOWED_DOMAINS.includes(domain);
};

module.exports = config;
