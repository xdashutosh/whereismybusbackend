# Auth API

Module `auth` · base path `/api/v1` · contract: ARCHITECTURE §5, §6 · source `backend/src/modules/auth/`.

Sessions use a **short-lived access JWT** (HS256, 15 min, claims `{ sub, role, tv }`) sent as
`Authorization: Bearer <token>`, plus an **opaque refresh token** (256-bit, only its SHA-256 is stored)
that is rotated on every use. Every authenticated request reloads the user row from the database, so
deactivation, role or scope changes, logout-all and password changes take effect immediately.

All `/auth/*` responses carry `Cache-Control: no-store`.

## Session object

`register`, `login`, `refresh` and `change-password` return the same session object:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "078cbee0-94e9-42bc-ae0a-2bafdfbaec79", "fullName": "System Administrator",
      "email": "system@example.com", "phone": null, "username": null, "role": "SYSTEM_ADMIN",
      "mustChangePassword": false, "stateId": null, "regionId": null, "depotId": null
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs…",
    "accessTokenExpiresAt": "2026-10-17T08:46:03.000Z",
    "refreshToken": "q8Xy…43 chars…",
    "refreshTokenExpiresAt": "2026-11-16T08:31:03.120Z"
  }
}
```

The response also sets the refresh cookie
`wimb_rt=<token>; HttpOnly; SameSite=Lax; Path=/api/v1/auth; Max-Age=<refresh TTL>` (`Secure` in production).

**Web vs mobile.** Web clients send `X-WIMB-Client: web` on every auth call. For them `refreshToken` in
the body is `null`: the token lives only in the httpOnly cookie, where page scripts cannot read it.
Mobile clients omit the header, keep `refreshToken` from the body (secure storage) and send it back in
the body.

## Password policy

At least 8 characters with at least one letter and one digit, at most 128 characters (and 72 bytes,
the bcrypt limit). Violations return `VALIDATION_ERROR` with the failing rule, for example
`{ "path": "password", "message": "Must contain at least one digit" }`.

---

## GET /auth/captcha

Public. Rate limit 30 per 10 min per IP. Issues a bot-protection challenge, depending on `CAPTCHA_PROVIDER`:

| Provider | Response `data` |
|---|---|
| `builtin` | `{ "provider": "builtin", "captchaId": "uuid", "svg": "<svg …>", "imageDataUri": "data:image/svg+xml;base64,…", "expiresAt": "…Z" }` |
| `turnstile` | `{ "provider": "turnstile", "siteKey": "0x4AAA…" }`. The client renders the widget and sends `captchaToken`. |
| `disabled` | `{ "provider": "disabled" }` (development and tests only; refused in production). |

A builtin challenge is a 6-character text to type (letters and digits, without the look-alikes
`0 o O 1 i l I`; answered **case-insensitively**, spaces ignored), valid for 5 minutes and **single use**:
the first answer consumes it, right or wrong. Only an HMAC of the answer is stored.

CAPTCHA fields accepted by `register`, `login` and `forgot-password`:
`captchaId` + `captchaAnswer` (builtin) or `captchaToken` (turnstile).

## POST /auth/register

Public; creates a **passenger** account and its `passenger_profiles` row. Rate limit 5 per hour per IP.
CAPTCHA required whenever the provider is not `disabled`.

```http
POST /api/v1/auth/register
Content-Type: application/json

{ "fullName": "Asha Rao", "email": "Asha.Rao@example.com", "phone": "+91 98450-12345",
  "password": "Secret123x", "captchaId": "8c1f…", "captchaAnswer": "k7RmWb" }
```

`201` returns the session object. The e-mail is lower-cased; the phone keeps digits and a leading `+`
(`+919845012345`). Unknown fields (for example `role`) are rejected, so a client cannot choose its role.

| Error | When |
|---|---|
| `400 VALIDATION_ERROR` | invalid field or unknown key |
| `400 CAPTCHA_REQUIRED` / `CAPTCHA_FAILED` | CAPTCHA missing, or wrong, expired or reused |
| `409 DUPLICATE` | `details.field` = `email` or `phone` |
| `429 RATE_LIMITED` | limit exceeded (`Retry-After` header) |

## POST /auth/login

Public. Rate limit 10 per 15 min per IP + identifier. The limiter normalises the identifier exactly like
the account lookup (e-mail lower-cased; phone separators removed), so every spelling of one phone number
or e-mail shares one budget.

```json
{ "identifier": "region.central@example.com", "password": "Wimb@12345" }
```

`identifier` matches the **e-mail** (when it contains `@`, any case), otherwise the **username** (drivers
use their employee code) or the **phone** (spaces and dashes ignored). `200` returns the session object
and sets the cookie.

**Failed attempts.** Every attempt is counted on the account's consecutive-failure counter *before* the
password is checked (atomically, so parallel attempts cannot slip past the limit); a successful sign-in
resets it to 0. With a CAPTCHA provider enabled the 5th failure answers `401` with
`captchaRequired: true`, and from then on every attempt answers `400 CAPTCHA_REQUIRED`
(`details.reason = "TOO_MANY_FAILED_ATTEMPTS"`) **even with the right password**, until an attempt carries
a valid CAPTCHA (a wrong CAPTCHA answers `CAPTCHA_FAILED` and is not counted as a password attempt).
Failures older than 24 hours no longer count. Identifiers that match **no account** follow exactly the same
sequence (401 ×4, 401 `captchaRequired: true`, then `CAPTCHA_REQUIRED`) with the same timing, so the
CAPTCHA gate does not reveal which e-mails, phones or employee codes exist.

| Error | `details` |
|---|---|
| `401 UNAUTHENTICATED` | `{ "reason": "INVALID_CREDENTIALS", "captchaRequired": false }`: the same answer for unknown accounts and wrong passwords. `captchaRequired: true` tells the client to show a CAPTCHA next time. |
| `401 UNAUTHENTICATED` | `{ "reason": "ACCOUNT_DISABLED" }` (only after a correct password) |
| `400 CAPTCHA_REQUIRED` / `CAPTCHA_FAILED` | see above |

If the account has `mustChangePassword: true` (a driver's first login, or an admin-issued temporary
password), every endpoint except the ones below answers `403 PASSWORD_CHANGE_REQUIRED` until
`POST /auth/change-password` succeeds:
`GET /auth/me`, `POST /auth/change-password`, `POST /auth/logout`, `POST /auth/logout-all`, `POST /auth/refresh`.

## POST /auth/refresh

Public (the refresh token is the credential). Rate limit 60 per 15 min per IP.

- Mobile: `{ "refreshToken": "q8Xy…" }`
- Web: empty body; cookie `wimb_rt` **plus** header `X-WIMB-Client: web`. A cookie without the header is
  refused (`reason: "CLIENT_HEADER_REQUIRED"`), so cross-site forms cannot use it.

Rotation is atomic: the presented token is revoked and its successor issued in one SQL statement, so
when several requests race with the same token exactly one wins. `200` returns a new session object
(and a new cookie).

| `401 UNAUTHENTICATED` `details.reason` | Meaning and client action |
|---|---|
| `ROTATED` | The token was rotated less than 10 s ago by a parallel request (two tabs). The family stays valid; use the token the winning request stored. The cookie is not cleared. |
| `REUSED` | A token revoked **more than 10 s ago** was replayed, a sign of theft. The **whole token family** is revoked; sign in again. |
| `REVOKED` | Signed out less than 10 s ago. |
| `EXPIRED`, `INVALID`, `MISSING`, `ACCOUNT_DISABLED` | Sign in again. |

## POST /auth/logout

Public. Revokes the presented refresh token (body `refreshToken`, or the cookie with
`X-WIMB-Client: web`) and clears the cookie. It is idempotent and works even when the access token has
expired.

```json
{ "success": true, "data": { "loggedOut": true, "revoked": true } }
```

## POST /auth/logout-all

Bearer token required. Bumps the user's `token_version`, which invalidates every outstanding access
token at once, revokes every refresh token and clears the cookie.

```json
{ "success": true, "data": { "loggedOut": true, "revokedSessions": 3 } }
```

## POST /auth/forgot-password

Public. Rate limit 5 per hour per IP + e-mail. CAPTCHA required when enabled.

```json
{ "email": "passenger@example.com", "captchaId": "…", "captchaAnswer": "4" }
```

Always `200` with the same body, whether or not the account exists (no enumeration). The lookup and
token creation take one statement in both cases, and the e-mail is sent in the background:

```json
{ "success": true, "data": { "message": "If an account exists for this e-mail address, a password reset link has been sent." } }
```

For an **active** account, a single-use token valid for 30 minutes is created (stored hashed; any earlier
unused link stops working) and `${APP_PUBLIC_URL}/reset-password?token=<token>` is e-mailed. Without SMTP
the message is written to the development log.

## POST /auth/reset-password

Public.

```json
{ "token": "<token from the link>", "newPassword": "NewSecret99" }
```

`200 { "passwordReset": true }`. Sets the password, clears `mustChangePassword` and the failure counter,
revokes **every session** (access and refresh) and every other pending reset link, and clears the cookie.
An unknown, used or expired token, or an inactive account, returns `400 VALIDATION_ERROR`
(`path: "token"`).

## POST /auth/change-password

Bearer token required (allowed while a change is pending). Rate limit: 5 failed attempts per 15 min per
signed-in user (successful changes do not count), so a stolen access token cannot be used to guess the
current password.

```json
{ "currentPassword": "Wimb@12345", "newPassword": "Fresh1234x" }
```

`200` returns a **new session object**. The password is changed, `mustChangePassword` is cleared, every
other session is revoked (`token_version` bump) and this device stays signed in with the returned tokens.

| Error | When |
|---|---|
| `400 VALIDATION_ERROR` `path: "currentPassword"` | current password wrong |
| `400 VALIDATION_ERROR` `path: "newPassword"` | policy violated, or same as the current password |
| `429 RATE_LIMITED` | more than 5 failed attempts in 15 min (`Retry-After` header) |

## GET /auth/me

Bearer token required (allowed while a change is pending).

```json
{
  "success": true,
  "data": {
    "user": { "id": "6fb5…", "fullName": "Bengaluru Central Region Admin", "email": "region.central@example.com",
              "phone": null, "username": null, "role": "REGION_ADMIN", "mustChangePassword": false,
              "stateId": "aba9…", "regionId": "e5b8…", "depotId": null },
    "scope": { "level": "REGION", "stateId": "aba9…", "stateCode": "KA", "stateName": "Karnataka",
               "regionId": "e5b8…", "regionCode": "BLR-C", "regionName": "Bengaluru Central",
               "depotId": null, "depotCode": null, "depotName": null,
               "depotIds": ["2813…", "43bb…"], "timezone": "Asia/Kolkata" },
    "driver": null,
    "permissions": ["audit.read", "buses.manage", "dashboard.read", "drivers.manage", "events.read",
                    "geo.depots.update", "geo.read", "imports.manage", "live.monitor", "notices.manage",
                    "notifications.read", "routes.manage", "schedules.manage", "schedules.read",
                    "settings.read", "stops.create", "stops.editOwn", "stops.read", "stops.requestChange",
                    "trips.lifecycle", "trips.manage", "trips.read", "users.manage"]
  }
}
```

- `scope.depotIds` is `null` for SYSTEM (meaning all depots). `timezone` is the state timezone (default
  `Asia/Kolkata`).
- `driver` (DRIVER only): `{ id, employeeCode, fullName, status, depotId, depotName }`.
- `permissions` are UI hints computed from the role **and the current platform settings**. For example
  `scheduling.freeze=true` removes `schedules.manage`/`trips.manage` from non-system admins,
  `stops.depotAdminCreateEnabled=false` removes `stops.create` from depot admins, and
  `trips.driverCanSuspend=false` removes `driver.trips.suspend`. The server enforces the same rules on
  every mutation regardless.

| Permission | Granted to |
|---|---|
| `dashboard.read` `geo.read` `settings.read` `audit.read` `events.read` `live.monitor` `stops.read` `stops.editOwn` `routes.manage` `buses.manage` `drivers.manage` `imports.manage` `schedules.read` `trips.read` `trips.lifecycle` `notices.manage` | every admin |
| `schedules.manage` `trips.manage` | every admin (non-system: unless `scheduling.freeze`) |
| `stops.create` | REGION, STATE, SYSTEM; DEPOT if `stops.depotAdminCreateEnabled` |
| `stops.requestChange` | DEPOT, REGION |
| `stops.editEstablished` / `stops.deleteEstablished` | SYSTEM; STATE unless disabled by `stops.stateAdminEditEnabled` / `stops.stateAdminDeleteEnabled` |
| `stopRequests.review` | STATE, SYSTEM |
| `geo.states.manage` | SYSTEM |
| `geo.regions.manage` `geo.depots.create` | STATE, SYSTEM |
| `geo.depots.update` | REGION, STATE, SYSTEM |
| `users.manage` | REGION, STATE, SYSTEM |
| `users.managePlatformAccounts` `settings.write` `system.status` `trips.forceStatus` | SYSTEM |
| `driver.schedule.read` `driver.trips.operate` `live.transmit` (+ `driver.trips.suspend` if `trips.driverCanSuspend`) | DRIVER |
| `passenger.profile` `passenger.favorites` `passenger.subscriptions` `notifications.read` | PASSENGER |

## Demo accounts (`npm run seed`)

`system@example.com`, `state.admin@example.com` (Karnataka), `region.central@example.com` (BLR-C),
`region.south@example.com` (BLR-S), `depot.shantinagar@example.com` (SHN), `depot.ecity@example.com` (ECY),
`passenger@example.com`. Password: `SEED_DEFAULT_PASSWORD`, otherwise `Wimb@12345` (development only;
printed by the seed command).
