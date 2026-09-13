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

---

# Natural voices for read-aloud

Settings → **Read emails aloud** puts a headphones button in the reader. With
no extra setup it speaks with whatever voice the device has, which on iOS is
usually the mechanical compact Siri voice. These steps switch it to Google
Cloud Text-to-Speech's neural voices, proxied through the same Worker so the
API key never reaches the browser.

Google's published free allowance for the Chirp 3 HD voices is **1 million
characters a month**, which is roughly 600–700 average emails read aloud — so
ordinary use is likely to cost nothing. Confirm the current figures on
[Google's pricing page](https://cloud.google.com/text-to-speech/pricing)
before relying on them, and set a quota cap (step 3) so a surprise can't
become a bill.

## Step 1 — Enable the API and make a key

In the [Google Cloud Console](https://console.cloud.google.com/), in the same
project as the OAuth client:

1. Enable **Cloud Text-to-Speech API**. Link a billing account if the console
   asks for one — the recurring free tier still sits behind a billing account,
   though nothing is charged inside the allowance.
2. **APIs & Services → Credentials → Create credentials → API key.** Not an
   OAuth client ID — that's the credential in step 1 of the section above, and
   it sits directly beneath this one in the same menu. Text-to-Speech reads
   none of your data, so there's no user to authenticate: an API key just
   identifies the project for billing. You'll get one opaque string starting
   `AIzaSy`, with no secret and no redirect URIs. Leave the existing OAuth
   client alone.
3. Restrict the key: under **API restrictions** choose *Restrict key* and
   select only **Cloud Text-to-Speech API**. Leave application restrictions
   unset — the key is used server-side from the Worker, not from a browser.

### If there's no "API key" option

Plenty of organisations block API key creation by policy, and in that console
the **Create credentials** menu offers only OAuth client ID and service
account. Two things to try before giving up on the key:

- Enable the **API Keys API**
  (`console.cloud.google.com/apis/library/apikeys.googleapis.com`) and reload
  the Credentials page — the option depends on it.
- Check you hold **Owner**, **Editor**, or **API Keys Admin** on the project.

If the console says an **organization policy** blocks it, the project belongs
to an organization — a personal Google account can't have one, so check the
resource picker for whose. The same goes if the service-account path below is
blocked instead: every organization created since 3 May 2024 enforces
`constraints/iam.managed.disableServiceAccountKeyCreation` as part of Google's
security baseline, which stops the JSON key download. Neither block is
something anyone chose.

**If the organization is yours**, grant an exception for this project rather
than switching the policy off everywhere. You need Organization Policy
Administrator (`roles/orgpolicy.policyAdmin`) at the organization level —
project Owner isn't enough:

1. **IAM & Admin → Organization policies**, and select **the project** in the
   resource picker. Selecting the project is what makes this an override
   rather than an org-wide change.
2. Filter for `key`, open the constraint that's blocking you, then
   **Manage policy → Override parent's policy →** Enforcement **Off**.
3. Create the credential, then set the policy back to **Inherit parent's
   policy**. A key that already exists keeps working; re-enforcing only stops
   new ones being made.

Prefer unblocking the **API key** over the service account where you have the
choice: it can be restricted to Text-to-Speech alone, whereas a
service-account JSON can't be restricted after the fact — which is why Google
blocks it by default.

**If the organization is someone else's**, an employer's say, don't relax its
security posture for this. Use a separate project with no organization
instead: sign in with a personal account (a separate browser profile helps —
signing in as the wrong account is the quiet failure here), create a project
that reads *No organization*, enable the API on it and link billing. The
voice credential shares nothing with the OAuth client, so it needn't share a
project either.

## Step 2 — Give it to the Worker

```sh
npx wrangler secret put GOOGLE_TTS_API_KEY
# paste the API key from step 1
```

Redeploy (`npx wrangler deploy`). The voice list in Settings fills in on the
next load; pick any voice and it's remembered per browser.

### Alternative: a service account

Same result, a few more steps, and it works where API keys are blocked.

1. **APIs & Services → Credentials → Create credentials → Service account.**
   Name it anything; it needs **no project role at all** — the Text-to-Speech
   API is enabled per project, not granted per principal, so an unroled
   account can still synthesise. Skip the optional grant steps.
2. Open it → **Keys → Add key → Create new key → JSON**. A file downloads.
3. Hand the whole file to the Worker, contents and all:

   ```sh
   npx wrangler secret put GOOGLE_TTS_SA_KEY < ~/Downloads/that-file.json
   ```

   Or paste the entire JSON into the dashboard's secret field. It must be the
   complete document, `{` to `}`, private key included.

The Worker signs a JWT with that key and trades it for an hour-long access
token, cached between requests. If both credentials are set the API key wins.

Treat the JSON as a password: it grants synthesis on your project to anyone
holding it. Delete the downloaded file once the secret is set.

## Step 3 — Guard the spend

Two controls, which do different things:

- **IAM & Admin → Quotas**, filtered to *Cloud Text-to-Speech API*. Set the
  per-minute request quota to **60**. Listening to an email steadily is about
  2 requests a minute — one 700-character chunk every 30–45 seconds, plus one
  fetched ahead — and even holding down skip only reaches ~20, so 60 is
  roughly triple the worst honest minute.

  This is the quota that hard-stops, so it's what bounds a runaway. Be clear
  about what it does and doesn't do, though: it caps the *rate*, not the
  month. Paired with the Worker's 1000-character request cap, 60 requests a
  minute is a ceiling of 60,000 characters a minute — far more than a month's
  free allowance if something ran at that rate unattended. Its real job is to
  keep abuse slow enough that the budget alert below reaches you first.
  (The quotas here are per-minute, not per-day; there's no monthly ceiling to
  set.)
- **Billing → Budgets & alerts**, scoped to this project, with alerts at
  50/90/100% of a few dollars. This only notifies; it doesn't stop anything,
  but it's what catches slow drift past the free allowance.

Also note the restrictions in step 1 do real work here: a key restricted to
the Text-to-Speech API can't be spent on anything else.

## Step 4 — Stop at the free allowance (optional)

Steps 3's controls bound the *rate* and tell you after the fact. Neither can
hold you inside the monthly free allowance, because no per-minute number can:
1,000,000 characters spread over a month is 23 characters a minute, and the
app needs about 1,200 just to speak continuously. The only thing that can is
the Worker refusing to spend past a total, which is what this step adds.

```sh
npx wrangler kv namespace create TTS_BUDGET
```

Wrangler prints an id. Uncomment the `[[kv_namespaces]]` block in
`wrangler.toml`, paste the id in, and commit — the deploy picks it up.

From then on the Worker keeps a character total per calendar month and refuses
requests that would pass the cap, answering before it calls Google so a refusal
costs nothing. The app drops to the device voice for the rest of the month and
says why. The default cap is 950,000, a little under Google's 1,000,000; set
`TTS_MONTHLY_CHAR_CAP` in `wrangler.toml` to change it.

Two things this buys beyond the in-app counter: the total covers **every
device** rather than one browser's share, and it's a stop rather than a
notice. Settings shows the Worker's figure once the namespace is bound.

The margin under the allowance is doing real work. KV has no atomic
increment, so two requests in flight can read the same total and one of their
additions is lost. The app sends at most two at a time, so the drift is small
and always an undercount — the 50,000-character gap absorbs it. Exact
accounting would want a Durable Object; this is a budget, not a ledger.

Leave the namespace uncreated and nothing is enforced: the Worker skips the
whole mechanism and the app falls back to its own per-browser estimate.

## How it works

- `/api/tts/voices` lists the good voice families for your language
  (Chirp 3 HD, Studio, Neural2, WaveNet — the Standard tier is filtered out).
- `/api/tts/speak` takes a chunk of cleaned-up email text and returns MP3.
  The app plays it through an `<audio>` element, which is why playback keeps
  going with the screen locked and shows up in the lock-screen controls.
- Authentication is an API key on the query string, or a service-account JWT
  exchanged for a Bearer token — whichever is configured. Either way the
  credential stays on the server and never reaches the browser.
- Both routes require the request to be same-origin **and** to carry the
  sign-in cookie from the OAuth flow above, so the quota isn't spendable by
  anyone who merely finds the URL. With `USE_REFRESH_BACKEND = false` there is
  no such cookie, and read-aloud falls back to the device voice.
- Speed is applied with the audio element's `playbackRate`, not by
  re-synthesising, so changing pace costs nothing and never re-bills.
- Chunks are remembered for the session, so replaying an email — or stepping
  back a sentence — doesn't spend the quota twice.
- `/api/tts/usage` reports where the month stands, so Settings shows a real
  figure before anything has been spoken in a session.

## Without the key

Everything above is optional. With neither `GOOGLE_TTS_API_KEY` nor
`GOOGLE_TTS_SA_KEY` the routes answer `501`, the app says so in Settings, and read-aloud uses the device's own voice
(which also covers offline reading). On iOS that voice is much better if you
first download an Enhanced or Premium voice under **Settings → Accessibility
→ Spoken Content → Voices**.
