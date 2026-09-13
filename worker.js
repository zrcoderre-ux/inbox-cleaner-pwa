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
// The app never sends more than TTS_CHUNK_CHARS (700) in one request, so this
// sits just above real traffic rather than at Google's own 5000-byte ceiling:
// it's the per-request half of the spend limit, and the project's per-minute
// quota is the other half. The two multiply, so keeping this tight matters.
const TTS_MAX_CHARS = 1000;
// Voice families worth offering, best-sounding first. Anything else Google
// lists (Standard, and the older novelty voices) is the mechanical-sounding
// tier this feature exists to avoid, so it's filtered out.
const TTS_TIERS = ['Chirp3-HD', 'Chirp-HD', 'Studio', 'Neural2', 'Polyglot', 'Wavenet'];
// Monthly character budget, enforced here so it holds across every device
// instead of per-browser. Sits under Google's 1,000,000-character free
// allowance: the margin covers both the counter's own imprecision (below) and
// the fact that Google's month and this one may not end at the same instant.
// Override with the TTS_MONTHLY_CHAR_CAP var; unset it and this applies.
const TTS_DEFAULT_CAP = 950000;
// Spent months are worth keeping briefly for a look back, not forever.
const TTS_USAGE_TTL = 70 * 24 * 60 * 60;
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
// Google Cloud Text-to-Speech, called with a credential that stays on the
// server. The app sends a chunk of cleaned-up email text and gets MP3 back.
// With neither credential set this answers 501 and the app falls back to
// whatever voice the device has.
async function handleTts(request, env, url) {
  if (!ttsHasCredential(env)) return json({ error: 'not_configured' }, 501);

  // This endpoint spends a metered quota, so it's for this app only: same
  // origin, and only for someone who actually has a session here. The sign-in
  // cookie is httpOnly, so another site's script can't borrow it.
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'bad_origin' }, 403);
  if (!Object.keys(readCookieMap(request)).length) return json({ error: 'not_signed_in' }, 401);

  const path = url.pathname.replace(/\/+$/, '');

  // Minting a service-account token can fail on its own (a malformed key, a
  // clock problem, Google refusing the assertion). Treat that like a refused
  // key: the app drops to the device voice and says so.
  let auth;
  try { auth = await ttsAuth(env); }
  catch (e) { return json({ error: 'credential_failed', detail: String(e && e.message || e) }, 403); }

  if (path === '/api/tts/voices' && request.method === 'GET') {
    const lang = url.searchParams.get('languageCode') || 'en-US';
    const res = await fetch(ttsUrl(TTS_VOICES_URL, auth, { languageCode: lang }), { headers: auth.headers });
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

    // Check the budget before spending any of it. Refusing here costs nothing;
    // finding out from Google's bill costs money.
    const usage = await ttsReadUsage(env);
    if (usage && usage.used + text.length > usage.cap) {
      return json({ error: 'monthly_cap', used: usage.used, cap: usage.cap }, 429);
    }

    const name = typeof body.voice === 'string' ? body.voice : '';
    // "en-US-Chirp3-HD-Achernar" → "en-US". A name and its language have to
    // agree or the API rejects the pair.
    const languageCode = name ? name.split('-').slice(0, 2).join('-')
                              : (typeof body.languageCode === 'string' ? body.languageCode : 'en-US');

    // No speakingRate here on purpose: the app changes speed with the audio
    // element's playbackRate, so one synthesis serves every speed (and not
    // every voice family accepts the parameter).
    const res = await fetch(ttsUrl(TTS_SYNTH_URL, auth), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth.headers },
      body: JSON.stringify({
        input: { text },
        voice: name ? { languageCode, name } : { languageCode },
        audioConfig: { audioEncoding: 'MP3' }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.audioContent) return ttsUpstreamError(res, data);

    // Only spend the budget on audio actually delivered.
    await ttsAddUsage(env, usage, text.length);

    const headers = {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
      // What this request cost against the monthly allowance.
      'x-tts-chars': String(text.length)
    };
    // And where that leaves the month, so the app shows a figure covering
    // every device rather than only this browser's share.
    if (usage) {
      headers['x-tts-month-chars'] = String(usage.used + text.length);
      headers['x-tts-month-cap'] = String(usage.cap);
    }
    return new Response(b64ToBytes(data.audioContent), { headers });
  }

  if (path === '/api/tts/usage' && request.method === 'GET') {
    const usage = await ttsReadUsage(env);
    return json(usage ? { enforced: true, used: usage.used, cap: usage.cap }
                      : { enforced: false });
  }

  return json({ error: 'not_found' }, 404);
}

// ── Credentials ────────────────────────────────────────────────────────────
// An API key is the simplest way in, but plenty of organisations block API key
// creation by policy — in that console the Credentials page offers only OAuth
// clients and service accounts. So a service account works too: the Worker
// signs a JWT with its private key and trades that for an access token.
//
// GOOGLE_TTS_API_KEY wins if both are set. GOOGLE_TTS_SA_KEY is the downloaded
// service-account JSON, pasted in whole.
const TTS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
// Access tokens last an hour. The isolate outlives a single request, so
// caching one here saves a round trip on nearly every call.
let ttsTokenCache = null;   // { token, expires }

function ttsHasCredential(env) {
  return !!(env && (env.GOOGLE_TTS_API_KEY || env.GOOGLE_TTS_SA_KEY));
}

async function ttsAuth(env) {
  if (env && env.GOOGLE_TTS_API_KEY) return { key: env.GOOGLE_TTS_API_KEY, headers: {} };
  const token = await ttsAccessToken(env.GOOGLE_TTS_SA_KEY);
  return { key: '', headers: { authorization: 'Bearer ' + token } };
}

function ttsUrl(base, auth, params) {
  const u = new URL(base);
  Object.keys(params || {}).forEach(k => u.searchParams.set(k, params[k]));
  if (auth.key) u.searchParams.set('key', auth.key);
  return u.toString();
}

async function ttsAccessToken(raw) {
  // Validate before consulting the cache, and tie the cache to the account it
  // was minted for: swapping the credential should take effect at once rather
  // than whenever the old token happens to expire.
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { throw new Error('the secret is not valid JSON'); }
  // Say what arrived, not just what's missing. The usual mistakes are pasting
  // the OAuth client JSON (top-level "web" or "installed") instead of the
  // service-account key, or pasting the document with quotes around it so it
  // parses as a string. Field names only — never their values.
  if (!sa || typeof sa !== 'object' || Array.isArray(sa)) {
    throw new Error('the secret parsed as a ' + (Array.isArray(sa) ? 'list' : typeof sa) +
                    ', not an object — check it was pasted as bare JSON, starting with {');
  }
  const missing = ['client_email', 'private_key'].filter(k => !sa[k]);
  if (missing.length) {
    const keys = Object.keys(sa);
    const looksLikeOAuth = keys.includes('web') || keys.includes('installed');
    // Length and opening character together separate a stored value that was
    // truncated from one that arrived whole but wrong.
    throw new Error('the secret has no ' + missing.join(' or ') +
      '; it is ' + raw.length + ' characters starting "' + raw.slice(0, 1) + '", with fields ' +
      (keys.slice(0, 10).join(', ') || 'none') + (keys.length > 10 ? ', …' : '') +
      (looksLikeOAuth
        ? ' — that is an OAuth client file, not a service-account key. Download the key from the service account itself, under its Keys tab.'
        : ' — expected a service-account key, which starts {"type": "service_account"}.'));
  }

  const now = Math.floor(Date.now() / 1000);
  if (ttsTokenCache && ttsTokenCache.issuer === sa.client_email && ttsTokenCache.expires > now + 60) {
    return ttsTokenCache.token;
  }

  const aud = sa.token_uri || TOKEN_ENDPOINT;
  const assertion = await ttsSignJwt(
    { iss: sa.client_email, scope: TTS_SCOPE, aud, iat: now, exp: now + 3600 },
    sa.private_key
  );
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'token exchange failed');
  }
  ttsTokenCache = {
    token: data.access_token,
    expires: now + (parseInt(data.expires_in, 10) || 3600),
    issuer: sa.client_email
  };
  return ttsTokenCache.token;
}

function b64url(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function ttsSignJwt(claims, privateKeyPem) {
  const enc = new TextEncoder();
  const head = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const signingInput = head + '.' + body;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(signingInput));
  return signingInput + '.' + b64url(sig);
}

function pemToDer(pem) {
  const body = String(pem).replace(/-----[^-]*-----/g, '').replace(/\s+/g, '');
  return b64ToBytes(body).buffer;
}

// ── Monthly budget ─────────────────────────────────────────────────────────
// Kept in KV under one key per calendar month. With no KV namespace bound the
// budget simply isn't enforced and the app falls back to its own per-browser
// estimate, so this is safe to deploy before the namespace exists.
function ttsMonthKey() {
  return 'chars:' + new Date().toISOString().slice(0, 7);
}

function ttsCap(env) {
  const n = parseInt(env && env.TTS_MONTHLY_CHAR_CAP, 10);
  return (isFinite(n) && n > 0) ? n : TTS_DEFAULT_CAP;
}

async function ttsReadUsage(env) {
  if (!env || !env.TTS_BUDGET) return null;  // no namespace bound — not enforced
  const key = ttsMonthKey();
  let used = 0;
  try { used = parseInt(await env.TTS_BUDGET.get(key), 10) || 0; } catch (e) {}
  return { key, used, cap: ttsCap(env) };
}

// KV has no atomic increment, so two requests in flight can read the same
// total and one of their additions is lost. The app sends at most two at once
// (the playing chunk and the one fetched ahead), each at most TTS_MAX_CHARS,
// so the drift is small and always an undercount — which is what the margin
// under the free allowance is for. Exact accounting would want a Durable
// Object; this is a budget, not a ledger.
async function ttsAddUsage(env, state, n) {
  if (!state || !n) return;
  try {
    await env.TTS_BUDGET.put(state.key, String(state.used + n), { expirationTtl: TTS_USAGE_TTL });
  } catch (e) {}
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
