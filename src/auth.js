'use strict';

// Google sign-in using the standard OAuth 2.0 "authorization code" flow.
//
// We talk to Google directly (no passport needed):
//   1. /auth/google          -> send the browser to Google's sign-in page
//   2. /auth/google/callback -> Google sends the browser back with a one-time
//                               code; we swap it for an ID token over HTTPS
//                               (using the client secret) and read the
//                               verified email address from it.
// Because the ID token is received straight from Google over TLS in exchange
// for our secret, Google's documentation allows reading it without checking
// its signature again.

const crypto = require('crypto');
const express = require('express');
const { buildContext, CHIEF_ID } = require('./permissions');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function decodeJwtPayload(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new Error('Malformed ID token');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

function createAuth({ config, db }) {
  const router = express.Router();

  router.get('/auth/google', (req, res) => {
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
      return res.redirect('/?error=not_configured');
    }
    const state = crypto.randomBytes(24).toString('hex');
    req.session = { oauthState: state };
    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      redirect_uri: config.REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    res.redirect(AUTH_URL + '?' + params.toString());
  });

  router.get('/auth/google/callback', async (req, res) => {
    try {
      const { code, state, error } = req.query;
      if (error) return res.redirect('/?error=cancelled');

      const expected = req.session && req.session.oauthState;
      if (!expected || !state || state !== expected || !code) {
        return res.redirect('/?error=state');
      }

      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(code),
          client_id: config.GOOGLE_CLIENT_ID,
          client_secret: config.GOOGLE_CLIENT_SECRET,
          redirect_uri: config.REDIRECT_URI,
          grant_type: 'authorization_code',
        }).toString(),
      });
      const tokens = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokens.id_token) {
        console.error('Google token exchange failed:', tokenRes.status, tokens.error, tokens.error_description || '');
        return res.redirect('/?error=google');
      }

      const claims = decodeJwtPayload(tokens.id_token);
      const issuerOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
      if (!issuerOk || claims.aud !== config.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now()) {
        return res.redirect('/?error=google');
      }
      if (!claims.email || claims.email_verified === false) {
        return res.redirect('/?error=google');
      }

      const email = String(claims.email).toLowerCase();
      if (!config.isEmailAllowed(email)) {
        console.warn('Sign-in refused (not on the allowed list):', email);
        req.session = null;
        return res.redirect('/?error=not_allowed');
      }

      const user = db.upsertLogin({ email, name: claims.name, picture: claims.picture });
      // If nobody has been made Chief yet (no CHIEF_EMAILS in .env), the first
      // person to sign in becomes Chief so the room is never left without one.
      if (!db.hasChief(config.CHIEF_EMAILS)) {
        user.roles = Array.from(new Set([...(user.roles || []), CHIEF_ID]));
        db.commit();
        console.log('First sign-in: ' + email + ' is now the Chief of the room.');
      }
      // A brand-new session object on every login (prevents session fixation).
      req.session = { email, loggedInAt: Date.now() };
      res.redirect('/');
    } catch (err) {
      console.error('Sign-in error:', err);
      res.redirect('/?error=google');
    }
  });

  router.post('/auth/logout', (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  function currentUser(req) {
    const email = req.session && req.session.email;
    if (!email || !config.isEmailAllowed(email)) return null;
    return db.getUser(email);
  }

  function requireAuth(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'not_signed_in' });
    req.user = user;
    req.ctx = buildContext(user, db.data.roles, config.CHIEF_EMAILS);
    next();
  }

  function requireChief(req, res, next) {
    requireNickname(req, res, () => {
      if (!req.ctx.chief) return res.status(403).json({ error: 'Only the Chief of the room can do this.' });
      next();
    });
  }

  function requireNickname(req, res, next) {
    requireAuth(req, res, () => {
      if (!req.user.nickname) return res.status(403).json({ error: 'nickname_required' });
      next();
    });
  }

  return { router, requireAuth, requireNickname, requireChief };
}

module.exports = { createAuth };
