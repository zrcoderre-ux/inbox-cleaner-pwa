// Cloudflare Worker for Inbox Cleaner.
//
// Purpose: eliminate hourly re-sign-ins. The static PWA uses Google's implicit
// OAuth flow, which only issues 1-hour access tokens and relies on a hidden
// iframe to renew them silently — a technique iOS Safari's tracking prevention
// routinely blocks. This Worker adds the server-side half of the OAuth
// "authorization code" flow so the app can obtain a long-lived **refresh
// token**, kept in an httpOnly cookie (never exposed to JavaScript), and mint
// fresh access tokens from it without any iframe or user interaction.
//
// It also serves the static assets (index.html, sw.js, icons, manifest) via the
// [assets] binding, so this one Worker replaces the static-only deployment.
//
// Setup: see AUTH-SETUP.md. You must set the GOOGLE_CLIENT_SECRET secret and,
// optionally, override GOOGLE_CLIENT_ID via a var.

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFAULT_CLIENT_ID = '348956142337-6g3l76tuaqsl0f20rdbd0u5bhuag2c4g.apps.googleusercontent.com';
const COOKIE_NAME = 'ic_rt';
// Refresh tokens are long-lived; keep the cookie ~400 days (Chrome's max).
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/oauth/')) {
      return handleOAuth(request, env, url);
    }
    // Everything else is a static asset.
    return env.ASSETS.fetch(request);
  }
};

function clientId(env) { return (env && env.GOOGLE_CLIENT_ID) || DEFAULT_CLIENT_ID; }

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
  });
}

// ── httpOnly cookie holding { email: refresh_token } ───────────────────────
function readCookieMap(request) {
  const raw = (request.headers.get('cookie') || '')
    .split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + '='));
  if (!raw) return {};
  try { return JSON.parse(atob(decodeURIComponent(raw.slice(COOKIE_NAME.length + 1)))) || {}; }
  catch (e) { return {}; }
}

function setCookieHeader(map) {
  const value = encodeURIComponent(btoa(JSON.stringify(map)));
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// Pull the email out of Google's id_token (a JWT). We received it directly from
// Google over TLS in exchange for our own code, so no signature check is needed
// here — we only use it to key refresh tokens per account.
function emailFromIdToken(idToken) {
  if (!idToken) return '';
  try {
    const payload = idToken.split('.')[1];
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const obj = JSON.parse(atob(padded));
    return (obj && obj.email) || '';
  } catch (e) { return ''; }
}

async function handleOAuth(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const secret = env && env.GOOGLE_CLIENT_SECRET;
  if (!secret) return json({ error: 'not_configured' }, 501);

  let body = {};
  try { body = await request.json(); } catch (e) {}

  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/api/oauth/exchange') {
    const code = body.code;
    const redirectUri = body.redirect_uri;
    if (!code || !redirectUri) return json({ error: 'missing_params' }, 400);

    const params = new URLSearchParams({
      code,
      client_id: clientId(env),
      client_secret: secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data.error || 'exchange_failed', detail: data.error_description }, 400);

    const email = emailFromIdToken(data.id_token);
    const map = readCookieMap(request);
    if (data.refresh_token && email) map[email] = data.refresh_token;

    const headers = {};
    if (data.refresh_token && email) headers['set-cookie'] = setCookieHeader(map);
    return json({ access_token: data.access_token, expires_in: data.expires_in, email }, 200, headers);
  }

  if (path === '/api/oauth/refresh') {
    const map = readCookieMap(request);
    const email = body.email || Object.keys(map)[0] || '';
    const refreshToken = map[email];
    if (!refreshToken) return json({ error: 'no_refresh_token' }, 401);

    const params = new URLSearchParams({
      client_id: clientId(env),
      client_secret: secret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await res.json();
    if (!res.ok) {
      // The refresh token was revoked or expired — drop it so the app falls
      // back to interactive sign-in cleanly.
      delete map[email];
      return json({ error: data.error || 'refresh_failed' }, 401, { 'set-cookie': setCookieHeader(map) });
    }
    return json({ access_token: data.access_token, expires_in: data.expires_in, email });
  }

  if (path === '/api/oauth/logout') {
    const map = readCookieMap(request);
    if (body.email) { delete map[body.email]; }
    const remaining = body.email ? Object.keys(map).length : 0;
    const cookie = (body.email && remaining) ? setCookieHeader(map) : clearCookieHeader();
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }

  return json({ error: 'not_found' }, 404);
}
