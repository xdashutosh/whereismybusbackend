# Deploying Where Is My Bus: Vercel (web) + Render (API), step by step

This guide takes the code from GitHub to a working demo system:

| Piece | Where it runs | Config file (repo) |
|---|---|---|
| Web admin (Super Admin + School Admin panels) | **Vercel** | `vercel.json` (admin repo root) |
| API + Socket.IO + background jobs (`whereismybus-api`, one service) | **Render**, native Node runtime, region Virginia | `render.yaml` (backend repo root, Blueprint) |
| Database | **Neon** PostgreSQL, AWS us-east-1, demo database `whereismybus_dev` (seeded) | none |
| Files (photos, documents) | **Linode Object Storage**, prefix `whereismybus/` | none |
| Parent OTP SMS | **WebPay Services** (OTP route), allow-list only | none |
| Maps | **Google Maps Platform** | none |
| Driver + parent apps | phones (Flutter), calling the Render API | `env/prod.example.json` (driverapp and parentapp repos) |

There is **no Docker and no Redis**. The Render service runs in *single-instance mode*
(`SINGLE_INSTANCE=true`): live bus positions, rate limits, Socket.IO rooms and the job scheduler live
inside the one Node process. Keep exactly one instance; a restart clears live positions and rate-limit
counters (they rebuild within seconds as buses report again).

Reference material (architecture, why each setting exists, the bucket privacy check):
[docs/DEPLOYMENT.md](DEPLOYMENT.md). The platform is four independent repositories checked out side by side
(`backend/`, `admin/`, `driverapp/`, `parentapp/`); paths below are written from that workspace folder. Run
`node scripts/check-render-config.mjs` in the backend repo after editing `render.yaml` or its CI, and
`node scripts/check-vercel-config.mjs` in the admin repo after editing `vercel.json`.

> **Never paste secrets into files that go to GitHub (the backend repository is public).** The real values live
> in `backend/.env` on your Mac (git-ignored). `backend/.env.render.local` (also git-ignored) holds exactly
> the values Render asks for, ready for Render's **Add from .env**.

---

## 0. How the pieces talk to each other (read once)

```
Browser ── https://<app>.vercel.app ──► Vercel (static web app)
   │            /api/*  ──── rewrite (same origin) ────► https://whereismybus-api.onrender.com/api/*
   └── wss (Socket.IO, access token) ─────────────────► https://whereismybus-api.onrender.com
Phones (driver / parent apps) ── https + wss ─────────► https://whereismybus-api.onrender.com
```

* `*.vercel.app` and `*.onrender.com` are **different sites**. The web sign-in keeps its refresh
  token in an httpOnly `SameSite=Strict` cookie, which a browser never sends to another site. So
  the web app calls the API through a **Vercel rewrite**: the browser talks to `/api/...` on the
  Vercel domain (same origin, cookie works) and Vercel forwards to Render.
* **Live updates (Socket.IO) cannot go through a Vercel rewrite** (Vercel does not proxy
  WebSockets). The web app connects straight to Render (`VITE_SOCKET_URL`) and authenticates with
  its access token. That is why Render must list the Vercel URL in `CORS_ORIGINS`.
* Recommended later: **custom domains** (`app.yourdomain.in` on Vercel, `api.yourdomain.in` on
  Render). They are the same site, so the web app can call the API directly (§11).

## 1. Before you start

You need a [Render](https://render.com) account, a [Vercel](https://vercel.com) account, and the
existing Neon, Linode, WebPay and Google Cloud accounts whose keys are in `backend/.env`.

1. **Private bucket (blocking):** follow [DEPLOYMENT.md §2](DEPLOYMENT.md#2-linode-object-storage--private-bucket-blocking).
   `node scripts/check-s3-private.mjs` (backend repo) must print `Bucket is private`.
2. **Neon app role:** `DB_APP_USER` / `DB_APP_PASSWORD` must exist in `backend/.env` (default user name
   `wimb_app`). Do **not** create that role in the Neon console: every start runs `db:setup-roles`, which
   creates or aligns it ([DEPLOYMENT.md §3.1](DEPLOYMENT.md#31-roles)).
3. **The demo database is shared with local development.** `whereismybus_dev` holds the seeded demo data
   (4 schools, 24 buses, 156 students, 100 trips; sign-ins in [SEED_DATA.md](SEED_DATA.md)). Your Mac and
   Render use the same database, so `JWT_ACCESS_SECRET` on Render **must equal** the one in `backend/.env`
   (TOTP secrets are encrypted with a key derived from it).

## 2. The code on GitHub

Four repositories: the backend is `https://github.com/xdashutosh/whereismybusbackend` (Render deploys it);
the admin web, the driver app and the parent app each have their own (private) repository. Before every push,
check that `git status` lists **no** `.env`, `.env.local`, `.env.render.local` or other `*.local` files (backend,
admin), and no `env/prod.json`, `android/key.properties`, `android/local.properties`, `android/signing/` or
`ios/Flutter/Secrets.xcconfig` (apps). Each repo's `.gitignore` excludes them (every `.env*` file except the
`*.example` templates); in the backend repo `git check-ignore -v .env.render.local` shows the rule.

## 3. Render: deploy the backend (one click)

1. Click **Deploy to Render** in the backend repository README, or Render Dashboard → **New → Blueprint** →
   connect GitHub → choose `whereismybusbackend` → branch `main`. Render reads `render.yaml` and shows
   **one** resource:

   | Resource | What it is |
   |---|---|
   | `whereismybus-api` | Web service, native **Node 24** runtime, Virginia, plan Starter, no `rootDir` (render.yaml sits at the backend repo root). Build: `npm ci --include=dev && npm run build`. Start: `npm run release && npm start` (migrations → `db:setup-roles` → `db:bootstrap`, then the API). Health check `/healthz`. |

2. Render asks for every value marked `sync: false`. Open `backend/.env.render.local` on your Mac, edit
   the four lines marked `EDIT`, then paste the whole file with **Add from .env** (or type each value):

   | Key | Value |
   |---|---|
   | `DB_HOST`, `DB_USER`, `DB_PASSWORD` | Neon **pooler** host (`…-pooler.us-east-1.aws.neon.tech`) and owner role, from `backend/.env` |
   | `DB_APP_USER`, `DB_APP_PASSWORD` | runtime app role, from `backend/.env` |
   | `AWS_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | the **private** Linode bucket and its key |
   | `JWT_ACCESS_SECRET` | the **same** value as `backend/.env` (shared demo database, §1 step 3) |
   | `SMS_API_URL`, `SMS_API_USERNAME`, `SMS_API_KEY`, `SMS_SENDER_ID`, `SMS_DLT_TEMPLATE_ID`, `SMS_OTP_MESSAGE` | WebPay settings from `backend/.env`; the message must match the DLT template exactly |
   | `SMS_DEV_ALLOWED_NUMBERS` | **EDIT**: the phone(s) that should get a real SMS during demos, e.g. `+919812345678,+919900000001` |
   | `CORS_ORIGINS` | **EDIT**: your Vercel URL, e.g. `https://your-admin.vercel.app` (no trailing `/`; fix it later in §5 if you do not know it yet) |
   | `APP_PUBLIC_URL` | **EDIT**: the same Vercel URL |
   | `PLATFORM_ADMIN_EMAIL` | **EDIT**: a real Super Admin e-mail (production refuses `superadmin@example.com`), see step 4 |
   | `GOOGLE_MAPS_SERVER_KEY` | Routes API server key (§9). Empty = straight-line routes. |

   Fixed in `render.yaml` (you do not type them): `NODE_ENV=production`, `DB_NAME=whereismybus_dev`,
   `DB_SSL=true`, `STORAGE_DRIVER=s3` (Linode `in-maa-1`, prefix `whereismybus/`), `TRUST_PROXY=1` (§8),
   `RATE_LIMIT_ENABLED=true`, `JOBS_IN_PROCESS=true`, `SINGLE_INSTANCE=true`, `SMS_ALLOWLIST_ONLY=true`,
   the SMS policy limits and `NODE_VERSION`.

3. Click **Apply** / **Deploy Blueprint**. The first build takes about 5 minutes. In `whereismybus-api` →
   **Logs** you should see `Applied N migration(s)` (or `No pending migrations`), the role setup, the
   bootstrap result, two warnings that are expected for this demo setup:
   * `single-instance mode: run exactly one instance; live state and rate limits reset on restart`
   * `SMS_ALLOWLIST_ONLY=true: only the N number(s) in SMS_DEV_ALLOWED_NUMBERS receive real SMS; …`

   and finally `HTTP + Socket.IO listening`.
4. **Super Admin.** The demo database already has a Super Admin (`superadmin@example.com`, the seed
   password in [SEED_DATA.md](SEED_DATA.md)). `db:bootstrap` never changes an existing admin. Two cases:
   * If that account was **never signed in** (password change and TOTP still pending) and it is the only
     Super Admin, the first deploy moves it to `PLATFORM_ADMIN_EMAIL` (log: `took over the unused
     placeholder account`). Sign in with your e-mail and the seed password. Local development then also
     signs in with that e-mail (same database).
   * Otherwise the log says no Super Admin was created for `PLATFORM_ADMIN_EMAIL`; the existing accounts
     keep working. To create a new one, add `PLATFORM_ADMIN_INITIAL_PASSWORD` (8+ characters, a letter and
     a digit) on Render for one deploy, sign in, then delete the variable.
5. Note the API URL at the top of `whereismybus-api`, e.g. `https://whereismybus-api.onrender.com`, and
   check it: `/healthz` → `"status":"ok"`, `/readyz` → `"status":"ready"` (database and migrations OK,
   `redis` reported as `skipped`).

### Single instance, plans and cost

* **One instance only.** `render.yaml` sets `numInstances: 1`; do not scale out or enable autoscaling
  (live state, rate limits and Socket.IO rooms are in process memory). A deploy or restart briefly drops
  sockets; the apps reconnect on their own.
* **Starter plan** (always on) is what `render.yaml` uses. The **Free** plan also works for a demo: the
  start command runs the migrations itself (Free has no pre-deploy step), but a free service **sleeps
  after ~15 minutes without traffic**, so open `/healthz` a minute before a demo. Background jobs
  (alerts, reminders, auto-closing stale trips) only run while the service is awake.
* The release step at start is idempotent: with nothing pending it takes a few seconds (it checks the
  migrations, re-applies the role grants and leaves the Super Admin alone).

### SMS during demos

`SMS_ALLOWLIST_ONLY=true` keeps WebPay credits and strangers' phones safe: only the numbers in
`SMS_DEV_ALLOWED_NUMBERS` get a real SMS. For any other number the OTP is **written to the Render log**
(`SMS (webpayservices, +91… is not in SMS_DEV_ALLOWED_NUMBERS: printed, not sent) … <code> …`), so you
can sign in as any seeded parent by reading the code from **Logs**. To send to every parent, set
`SMS_ALLOWLIST_ONLY=false` on Render (Environment) and save.

## 4. Vercel: deploy the web admin

1. If Render gave the API a different hostname than `whereismybus-api.onrender.com` (the name was
   taken), edit **two lines** in `vercel.json` (admin repo) and push:
   * the `/api/:path*` rewrite destination → `https://<your-api>.onrender.com/api/:path*`
   * in the `Content-Security-Policy` value, `https://whereismybus-api.onrender.com` and
     `wss://whereismybus-api.onrender.com` (`connect-src`) → your host.

   Then run `node scripts/check-vercel-config.mjs` in the admin repo. Rewrite destinations cannot read
   environment variables, which is why this is a file edit.
2. Vercel → **Add New → Project** → import the **admin** GitHub repository.
3. **Root Directory: the repo root** (leave it empty / `./`; the repo is self-contained: its `shared/` copy
   is inside it). Framework, install and build commands and the output directory come from `vercel.json`:
   * install: `npm ci --include=dev` (postinstall builds `./shared`)
   * build: `npm run build` (builds `shared/`, type-checks, then `vite build`) → `dist/`
4. **Environment Variables** (Production and Preview) — template: `.env.production.example` (admin repo):

   | Key | Value |
   |---|---|
   | `VITE_API_BASE_URL` | `/api/v1` (or leave unset — that is the default). **Never** the onrender.com URL (cross-site: users would be signed out on every reload). |
   | `VITE_SOCKET_URL` | your Render API origin, e.g. `https://whereismybus-api.onrender.com` |
   | `VITE_GOOGLE_MAPS_API_KEY` | the browser Maps key (§9) |
   | `VITE_GOOGLE_MAPS_MAP_ID` | optional |
   | `VITE_SENTRY_DSN` | optional: Sentry DSN for web error reports (no personal data; empty = off — see DEPLOYMENT.md §11.6) |

5. **Deploy**. Note the production URL, e.g. `https://whereismybus.vercel.app`.

What `vercel.json` also does: deep links such as `/school/trips` load the app (SPA fallback to
`/index.html` for everything except `/assets/*`); hashed `/assets/*` are cached for a year;
`index.html` is `no-cache` (users get new releases immediately); `/api` responses are never cached
by Vercel's CDN; pages get a Content-Security-Policy (Google Maps, UI5 fonts, Socket.IO to Render,
images from Linode presigned URLs), `X-Frame-Options: DENY`, HSTS and `nosniff`.

## 5. Connect the two (CORS)

On Render → `whereismybus-api` → **Environment**:

* `CORS_ORIGINS` = your exact Vercel production URL(s), comma-separated, e.g.
  `https://whereismybus.vercel.app` (add a custom domain here too when you have one).
* `APP_PUBLIC_URL` = the same URL.
* Optional, for the live map on **preview** deployments: `CORS_ORIGIN_PATTERNS` = an anchored regular
  expression such as `^https://whereismybus-[a-z0-9-]+-yourteam\.vercel\.app$` (space-separate several).
  Each entry must start with `^https://` and end with `$`; the API refuses to start otherwise. REST calls
  on previews already work without this (they go through the same-origin rewrite).

Save → Render restarts the API with the new values (about 2 minutes).

## 6. Smoke test (5 minutes)

1. `https://<api>.onrender.com/healthz` → `ok`; `/readyz` → `ready`.
2. `https://<app>.vercel.app/api/v1/auth/me` → a JSON `401` from the API (not a Vercel 404 page).
3. Open `https://<app>.vercel.app/school/trips` directly → the sign-in page loads (SPA fallback).
4. After §7/§8: sign in as a school admin and **reload the page** → you stay signed in.
   DevTools → Application → Cookies shows `wimb_rt` on the Vercel host, path `/api/v1/auth`,
   `HttpOnly`, `Secure`, `SameSite=Strict`.
5. Live fleet: start a trip from the driver app; the bus moves on the web map without reloading.
   DevTools → Network → WS shows `wss://<api>.onrender.com/socket.io/…` with status 101.
6. Upload a bus photo or document; open it. Note: Vercel limits proxied request bodies to about
   4.5 MB — larger web uploads fail with 413 until you move to custom domains (§11).
7. Export a list as CSV (e.g. Trips → Export CSV).
8. Parent app: request an OTP for a phone in `SMS_DEV_ALLOWED_NUMBERS` → the SMS arrives. For any other
   seeded parent the code appears in the Render log (§3, SMS during demos).

## 7. First sign-in (Super Admin)

1. Open `https://<app>.vercel.app/platform/login` and sign in with the Super Admin from §3 step 4
   (`PLATFORM_ADMIN_EMAIL` and the seed password, or the existing demo account).
2. **TOTP enrolment** opens: scan the QR code with the authenticator app (Google Authenticator,
   Microsoft Authenticator, 1Password…) of the person who will **own** this account, enter the 6-digit
   code. Keep that phone safe — every later sign-in needs a code from it.
3. You are asked to **change the password** (the initial one stops working).
4. Delete `PLATFORM_ADMIN_INITIAL_PASSWORD` on Render if you set it (§3 step 4).

`npm run db:bootstrap` (part of every start) only ever *creates* this admin when it does not exist
(or takes over the never-used placeholder account): it never changes a used admin's password, TOTP or
status, and never adds demo data.

## 8. Client IPs, rate limits and `TRUST_PROXY`

`TRUST_PROXY=1` (set in `render.yaml`) tells the API to trust exactly one proxy — Render's own load
balancer — and take the client IP it reports. It must **not** be raised to 2: phones, sockets and
anyone calling `onrender.com` directly would then be able to choose the IP they are counted under by
sending their own `X-Forwarded-For` header.

The trade-off with the Vercel rewrite: web requests reach Render from **Vercel's servers**, so the API
sees a Vercel egress IP for web traffic (in rate limits and in the audit log's IP column). What still
protects sign-in:

* **Per-account lockout:** 5 wrong passwords lock that account for 15 minutes, whatever the IP.
* **Per-account + IP limiter** on login (10 failures / 15 min) and the per-network limiter
  (30 failures / 15 min); OTP limits per phone number (5 / hour), per IP, and a global daily SMS cap.
* Signed-in traffic is rate-limited **per account** (a valid access token moves a request out of the
  per-IP bucket), so web users sharing a Vercel egress IP never throttle each other.

Mobile apps and live sockets connect to Render directly, so their IPs are real. With **custom domains**
(§11) the browser calls the API directly too and every IP in the audit log is the user's real IP —
keep `TRUST_PROXY=1` in that mode as well. Verify once: sign in from a phone on mobile data, open
the audit log (`/platform/audit-logs`) and compare the IP with `curl -s https://checkip.amazonaws.com`
run on that phone's network.

## 9. Google Maps keys

Google Cloud Console → APIs & Services:

1. **Enable APIs:** Maps JavaScript API (web admin), Maps SDK for Android, Maps SDK for iOS (apps),
   Routes API (backend road-following routes and ETAs).
2. **Browser key** (`VITE_GOOGLE_MAPS_API_KEY`): Application restriction **HTTP referrers** →
   `https://<app>.vercel.app/*` (plus your custom domain, and `http://localhost:5173/*` only on a
   separate dev key); API restriction **Maps JavaScript API**.
3. **App keys** (`GOOGLE_MAPS_KEY` for the Flutter builds): restrict to Android apps (package name +
   SHA-1 of the signing certificate — from Play Console → App integrity) and iOS apps (bundle ID); API
   restriction Maps SDK for Android / iOS.
4. **Server key** (`GOOGLE_MAPS_SERVER_KEY` on Render): API restriction **Routes API** only. Render has
   no fixed outbound IP on standard plans, so restrict by API rather than by IP.
5. Set a budget alert in Billing.

## 10. Onboard the first school

As the Super Admin on the web app:

1. **Schools → Create** (a short wizard): school details (name, login code such as `GWIS-BLR` — drivers
   type it to sign in — institution type school / college / university, time zone), address, contact and
   map location, plan and limits (buses, students, validity) and logo, then the first **school admin**
   (full name, e-mail, mobile, and how they get the first password).
2. The confirmation dialog shows the school admin's first password **once** — send it to them securely
   together with `https://<app>.vercel.app/school/login`. They must change it at first sign-in.
3. The school admin then sets up, in this order: **Settings** (speed limit, alert recipients, parent
   visibility), **Buses** (+ documents and photos), **Staff** (drivers/conductors get sign-in
   credentials for the driver app), **Routes** and stops, **Schedules**, **Students** and **Parents**
   (single entries or CSV import from the template), bus/stop assignments.
4. Drivers sign in to the driver app with the school code + their username/phone + PIN; parents sign
   in to the parent app with their phone number + SMS OTP.

## 11. Custom domains (recommended once you own a domain)

`app.yourdomain.in` (Vercel) and `api.yourdomain.in` (Render) share the registrable domain, so they are
the **same site**: the browser sends the `SameSite=Strict` refresh cookie on direct calls, uploads go
straight to Render (no 4.5 MB proxy limit) and the API sees real client IPs.

1. Render → `whereismybus-api` → Settings → Custom Domains → add `api.yourdomain.in`, create the CNAME
   it shows at your DNS provider, wait for the certificate.
2. Vercel → Project → Settings → Domains → add `app.yourdomain.in` (CNAME as shown).
3. Vercel environment variables: `VITE_API_BASE_URL=https://api.yourdomain.in/api/v1`,
   `VITE_SOCKET_URL=https://api.yourdomain.in`. The web client supports both modes: a relative base
   uses the rewrite, an absolute base calls the API directly (`credentials: 'include'`, so the cookie
   travels). Keep the `/api` rewrite in `vercel.json` (harmless; the `*.vercel.app` URL keeps working)
   and add `https://api.yourdomain.in` / `wss://api.yourdomain.in` to the CSP `connect-src`.
4. Render: `CORS_ORIGINS=https://app.yourdomain.in` (keep the vercel.app URL too if you still use it),
   `APP_PUBLIC_URL=https://app.yourdomain.in`, `TRUST_PROXY=1` (unchanged).
5. Rebuild the mobile apps with `API_BASE_URL=https://api.yourdomain.in` (old builds keep working on the
   onrender.com URL as long as that service exists).
6. Update the Google browser-key referrers (§9). Redeploy Vercel (Vite bakes the variables in).

Cookie details (no change needed): the cookie is host-only on the API host, path `/api/v1/auth`,
`HttpOnly`, `Secure`, `SameSite=Strict`; CORS allows credentials only for the listed origins.

## 12. Mobile apps (release builds)

Both apps read the backend origin at build time with `--dart-define` (never hard-coded):

| Define | Value |
|---|---|
| `API_BASE_URL` | `https://whereismybus-api.onrender.com` (no `/api/v1`; it is appended) — or `https://api.yourdomain.in` |
| `SOCKET_URL` | optional; Socket.IO origin, defaults to `API_BASE_URL` |
| `GOOGLE_MAPS_KEY` | the app Maps key (§9 step 3) |
| `FIREBASE_*` | optional, for push notifications (see the app READMEs) |

A release build without an `https://` `API_BASE_URL` refuses to start and shows a configuration
message (debug builds default to `localhost`), so a misconfigured build is caught on the first launch.
Each app has `env/prod.example.json`: copy it to `env/prod.json` (git-ignored) and fill in the values.

```bash
cd driverapp                 # then the same in parentapp
cp env/prod.example.json env/prod.json   # edit API_BASE_URL and GOOGLE_MAPS_KEY
flutter build appbundle --release --dart-define-from-file=env/prod.json   # Android → Play Console
flutter build ipa       --release --dart-define-from-file=env/prod.json   # iOS → App Store Connect (needs a Mac with Xcode)
```

Signing keys, store listings and Firebase setup: `driverapp/README.md`, `parentapp/README.md`.
The store listings need the privacy policy URL ([PRIVACY.md](PRIVACY.md)).

## 13. Latency (India)

Neon is in AWS **us-east-1** and the Render services are in **Virginia** next to it, so database round
trips stay at ~1–2 ms. Users in India still pay ~200–250 ms per request crossing to the US (Vercel serves
the static app from a nearby edge, but every `/api` call goes to Virginia). For Indian schools consider
moving **both** to Singapore together: a Neon project in `aws-ap-southeast-1` (restore/migrate the
database) and `region: singapore` for the service in `render.yaml`. Never split them across
continents — each API request makes several database round trips.

## 14. Demo database and real schools

* This Blueprint points at the **demo** database `whereismybus_dev` on purpose (`DB_NAME` in
  `render.yaml`), so demos show seeded schools, buses, students and trips. Your Mac uses the same
  database: anything you change in a demo is visible locally and the other way round.
* `npm run seed` refuses `NODE_ENV=production`; never force it against a database real schools use.
* **Before onboarding a real school**, switch to a clean database: create it on Neon (e.g.
  `whereismybus`), set `DB_NAME` to it on Render, set `SMS_ALLOWLIST_ONLY=false` (parents need real SMS)
  and give the Super Admin a fresh `PLATFORM_ADMIN_INITIAL_PASSWORD` for one start. The release step
  migrates the empty database and creates the Super Admin; no demo data is added.
* Backups: Neon's point-in-time restore (Neon console → your project → Backup & Restore). Monitoring and
  health checks: [OPERATIONS.md](OPERATIONS.md).

## 15. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Start fails with `No Super Admin exists yet` (empty database only) | Set `PLATFORM_ADMIN_INITIAL_PASSWORD` (8+ chars, letter + digit) and redeploy. |
| Start fails with `PLATFORM_ADMIN_EMAIL is not set` | Set `PLATFORM_ADMIN_EMAIL` to a real e-mail (the placeholder `superadmin@example.com` is refused in production). |
| Start fails with `REDIS_URL is required in production` or `SINGLE_INSTANCE=true requires JOBS_IN_PROCESS=true` | `SINGLE_INSTANCE` or `JOBS_IN_PROCESS` was changed on Render: both must be `true` (no Redis in this setup). |
| Deploy fails with `Invalid configuration: - …` | The log lists each problem (e.g. `CORS_ORIGINS is required`, `TRUST_PROXY must be …`, a `CORS_ORIGIN_PATTERNS entry … must be anchored`). Fix the variable on Render. |
| Start: `App role is not configured` / setup-roles refuses the role | Set `DB_APP_USER`/`DB_APP_PASSWORD`; do not create that role in the Neon console (it would join `neon_superuser`). |
| API log: `Database schema is not up to date` | A migration did not run: Render → `whereismybus-api` → Manual Deploy (the start command runs `npm run release` first). |
| Migration fails with a checksum mismatch | A migration file that already ran was edited. Revert it and add a new migration instead. |
| Web: signed out after every reload | `VITE_API_BASE_URL` points at onrender.com (cross-site cookie). Set it to `/api/v1` (or unset) and redeploy Vercel. Check DevTools → Cookies for `wimb_rt` on the Vercel host. |
| Web: `401` on every request right after sign-in | Secret issue: `JWT_ACCESS_SECRET` on Render must equal `backend/.env` (shared demo database). **Never change `JWT_ACCESS_SECRET`** once a Super Admin has enrolled TOTP — the TOTP secrets are encrypted with a key derived from it; rotate token signing with `JWT_ACCESS_KEYS` + `JWT_ACTIVE_KID` instead (DEPLOYMENT.md §11.4). Also check the `/api` rewrite host in `vercel.json` points at the right service. |
| Web: `/api/...` returns a Vercel 404 page or `index.html` | The `/api/:path*` rewrite is missing or below the SPA fallback; run `node scripts/check-vercel-config.mjs` (admin repo). |
| Web: `502`/`504` from `/api` after idle time | Free Render instance waking up: open `/healthz` first, or use the Starter plan. |
| Browser console: `blocked by CORS policy` on `socket.io` | `CORS_ORIGINS` does not contain the exact page origin (scheme + host, no trailing slash). Previews need `CORS_ORIGIN_PATTERNS`. |
| Live map never updates, WS shows failed/`403` | `VITE_SOCKET_URL` unset or wrong (Vercel cannot proxy WebSockets); CSP `connect-src` must contain `wss://<api host>`. |
| Browser console: `Refused to connect/load … Content Security Policy` | Add the host to the matching directive in `vercel.json` (admin repo) (e.g. a renamed Render service or a custom API domain). |
| Map shows "Google Maps key not configured" | `VITE_GOOGLE_MAPS_API_KEY` missing at **build** time → set it and redeploy Vercel. "RefererNotAllowed" → add the domain to the key's referrers. |
| Upload fails with `413` on the web | Vercel's proxied body limit (~4.5 MB) → smaller file or custom domains (§11). |
| Parent OTP never arrives | With `SMS_ALLOWLIST_ONLY=true` only `SMS_DEV_ALLOWED_NUMBERS` get an SMS: read the code in the Render log. For allowed numbers: WebPay credits or a DLT template mismatch (check the log for the provider response and `SMS_OTP_MESSAGE` vs the DLT template text). |
| Live positions or login lockouts vanished | Expected after a restart or deploy in single-instance mode; they rebuild as buses report again. |
