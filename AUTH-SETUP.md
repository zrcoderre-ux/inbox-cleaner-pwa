# Reducing sign-in prompts: the refresh-token backend

By default Inbox Cleaner uses Google's **implicit** OAuth flow: it gets a
1-hour access token and tries to renew it silently with a hidden iframe. On
iOS (especially when installed to the Home Screen), Safari's tracking
prevention blocks that iframe, so you get bounced to the sign-in screen about
once an hour.

This optional setup switches the app to the **authorization-code flow with a
refresh token**. The refresh token lives in an httpOnly cookie on your Worker
and is used to mint new access tokens with a plain same-origin request — no
iframe, no prompt. After this you sign in roughly **once** and stay signed in
until you explicitly sign out or revoke access.

Everything ships dormant: until you complete the steps below **and** flip the
flag in step 4, the app keeps using the original implicit flow.

---

## What's in the repo

- `worker.js` — Cloudflare Worker. Serves the static files **and** three OAuth
  endpoints: `/api/oauth/exchange`, `/api/oauth/refresh`, `/api/oauth/logout`.
- `wrangler.toml` — Worker config with the static-assets binding.

## Step 1 — Make the OAuth client a "Web application" with a secret

In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. Open your OAuth 2.0 Client ID (the one already hardcoded in `index.html`).
   It must be of type **Web application**. (If it's currently a different type,
   create a Web application client and update `OAUTH_CLIENT_ID` in `index.html`.)
2. Under **Authorized redirect URIs**, ensure your app URL with a trailing
   slash is listed, e.g. `https://inbox-cleaner-pwa.<you>.workers.dev/`.
3. Copy the **Client secret** — you'll need it in step 3.

## Step 2 — Deploy the Worker

From the repo root:

```sh
npx wrangler deploy
```

This deploys `worker.js` with the static files bound as assets, replacing the
static-only deployment. (Your existing URL stays the same.)

## Step 3 — Set the client secret

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET
# paste the secret from step 1 when prompted
```

(If you created a *new* Web client in step 1, also set its ID — either edit
`OAUTH_CLIENT_ID` in `index.html`, or uncomment `GOOGLE_CLIENT_ID` in
`wrangler.toml`.)

## Step 4 — Turn the flow on

In `index.html`, set:

```js
const USE_REFRESH_BACKEND = true;
```

Redeploy (`npx wrangler deploy`). On your next sign-in, Google will ask for
consent once; after that the app renews silently from the refresh token.

---

## How it works

- **Sign in** → `response_type=code` with `access_type=offline` &
  `prompt=consent`, so Google returns a one-time code **and** guarantees a
  refresh token.
- The app POSTs the code to `/api/oauth/exchange`. The Worker swaps it (using
  the client secret) for an access token + refresh token, stores the refresh
  token in an httpOnly cookie keyed by your email, and returns just the access
  token to the page.
- When the access token nears expiry (on resume, on a 401, or on the periodic
  refresh), the app POSTs to `/api/oauth/refresh`; the Worker uses the cookie's
  refresh token to mint a fresh access token. No iframe, so iOS can't block it.
- **Sign out** POSTs to `/api/oauth/logout`, which drops that account's refresh
  token from the cookie.

Multiple accounts are supported: the cookie holds a `{ email: refresh_token }`
map, and refresh requests pass the active account's email.

## Reverting

Set `USE_REFRESH_BACKEND = false` and redeploy. The app returns to the implicit
flow. The Worker's OAuth endpoints simply go unused (and return `501` if the
secret isn't set), so they're harmless to leave deployed.
