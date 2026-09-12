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
const TTS_SYNTH_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const TTS_VOICES_URL = 'https://texttospeech.googleapis.com/v1/voices';
// Google caps a synthesize request at 5000 bytes of input. The app chunks a
// sentence or two at a time, so anything near this is a bug — or someone else
// spending the quota.
const TTS_MAX_CHARS = 2000;
// Voice families worth offering, best-sounding first. Anything else Google
// lists (Standard, and the older novelty voices) is the mechanical-sounding
// tier this feature exists to avoid, so it's filtered out.
const TTS_TIERS = ['Chirp3-HD', 'Chirp-HD', 'Studio', 'Neural2', 'Polyglot', 'Wavenet'];
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
    if (url.pathname.startsWith('/api/tts/')) {
      return handleTts(request, env, url);
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

// ── Text-to-speech proxy ───────────────────────────────────────────────────
// Google Cloud Text-to-Speech, called with an API key that stays on the server.
// The app sends a chunk of cleaned-up email text and gets MP3 back. Without
// GOOGLE_TTS_API_KEY set this answers 501 and the app falls back to whatever
// voice the device has.
async function handleTts(request, env, url) {
  const key = env && env.GOOGLE_TTS_API_KEY;
  if (!key) return json({ error: 'not_configured' }, 501);

  // This endpoint spends a metered quota, so it's for this app only: same
  // origin, and only for someone who actually has a session here. The sign-in
  // cookie is httpOnly, so another site's script can't borrow it.
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'bad_origin' }, 403);
  if (!Object.keys(readCookieMap(request)).length) return json({ error: 'not_signed_in' }, 401);

  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/api/tts/voices' && request.method === 'GET') {
    const lang = url.searchParams.get('languageCode') || 'en-US';
    const res = await fetch(`${TTS_VOICES_URL}?languageCode=${encodeURIComponent(lang)}&key=${key}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return ttsUpstreamError(res, data);
    const voices = (data.voices || [])
      .map(v => ({ name: v.name, gender: v.ssmlGender || '', tier: ttsVoiceTier(v.name) }))
      .filter(v => v.tier)
      .sort((a, b) => TTS_TIERS.indexOf(a.tier) - TTS_TIERS.indexOf(b.tier) ||
                      a.name.localeCompare(b.name));
    return json({ voices }, 200, { 'cache-control': 'private, max-age=86400' });
  }

  if (path === '/api/tts/speak' && request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return json({ error: 'missing_text' }, 400);
    if (text.length > TTS_MAX_CHARS) return json({ error: 'text_too_long', max: TTS_MAX_CHARS }, 413);

    const name = typeof body.voice === 'string' ? body.voice : '';
    // "en-US-Chirp3-HD-Achernar" → "en-US". A name and its language have to
    // agree or the API rejects the pair.
    const languageCode = name ? name.split('-').slice(0, 2).join('-')
                              : (typeof body.languageCode === 'string' ? body.languageCode : 'en-US');

    // No speakingRate here on purpose: the app changes speed with the audio
    // element's playbackRate, so one synthesis serves every speed (and not
    // every voice family accepts the parameter).
    const res = await fetch(`${TTS_SYNTH_URL}?key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: name ? { languageCode, name } : { languageCode },
        audioConfig: { audioEncoding: 'MP3' }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.audioContent) return ttsUpstreamError(res, data);

    return new Response(b64ToBytes(data.audioContent), {
      headers: {
        'content-type': 'audio/mpeg',
        'cache-control': 'no-store',
        // What this request cost against the monthly free tier, so the app can
        // show the running total.
        'x-tts-chars': String(text.length)
      }
    });
  }

  return json({ error: 'not_found' }, 404);
}

function ttsVoiceTier(name) {
  const lower = String(name || '').toLowerCase();
  return TTS_TIERS.find(t => lower.includes('-' + t.toLowerCase())) || '';
}

// Pass Google's own status through where it's meaningful — the app tells quota
// exhaustion and a misconfigured key apart and reacts differently to each.
function ttsUpstreamError(res, data) {
  const err = (data && data.error) || {};
  const status = (res.status >= 400 && res.status < 600) ? res.status : 502;
  return json({ error: err.status || 'tts_failed', detail: err.message || '' }, status);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
