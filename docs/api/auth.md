# Auth API

Contract §6, blueprint §5 / §8.1. Base `/api/v1`. Source: `backend/src/modules/auth/`.

## Tokens and sessions

* **Access token**: HS256 JWT, 15 minutes, claims `sub`, `role`, `school_id` (null for super admins and
  parents), `sid`. Every request reloads the session and the account, so logout, deactivation and
  school suspension take effect immediately.
* **Refresh token**: opaque, 30 days, stored only as SHA-256. Each refresh **rotates** it into a new
  session row of the same family. Presenting an already-rotated token again counts as reuse: the
  whole family is revoked and its sockets are disconnected (`401`, `details.reason = REFRESH_TOKEN_REUSED`).
  Clients should refresh one request at a time; see the grace window below for concurrent refreshes and retries.
* **Refresh grace window (30 s)**: re-presenting a refresh token that was rotated at most 30 seconds ago,
  **from the same client and device**, returns the **same successor** (same `refreshToken`, `sessionId` and
  `refreshTokenExpiresAt`, a freshly signed `accessToken`) instead of counting as reuse. This covers the driver
  app's two isolates refreshing the same pair at the same moment and a retry after a lost response. "Same
  device" means the same `X-Device-Id` header (mobile; without it there is no grace answer) or the same
  `User-Agent` (web). Outside the window, from another device, or once the successor was itself rotated or
  revoked, reuse detection applies unchanged. The successor token is kept only encrypted (AES-256-GCM) for the
  window and wiped when the family is revoked (migration 900).
* **Web vs mobile**: requests with `X-WIMB-Client: web` get the refresh token only as the httpOnly cookie
  `wimb_rt` (`Path=/api/v1/auth`, `SameSite=Strict`, `Secure` in production) and must send the same header
  on `/auth/refresh` and `/auth/logout`. Mobile clients get `refreshToken` in the body and send it back in the
  body. A token issued to one client type is refused for the other (`CLIENT_MISMATCH`).
  Because the cookie is `SameSite=Strict`, the web app must reach the API **same-site**: in production it
  calls the relative `/api/v1`, which `admin/vercel.json` rewrites to Render (`*.vercel.app` →
  `*.onrender.com` direct would be cross-site and the cookie would never be sent). See `docs/DEPLOYMENT.md`.
* **Lockout**: 5 failed sign-ins within 15 minutes lock the account for 15 minutes (`429 RATE_LIMITED`,
  `details.reason = ACCOUNT_LOCKED`, `Retry-After`). Every attempt reserves its slot atomically before the
  password, PIN or TOTP code is checked, so even parallel requests never get more than 5 credentials
  evaluated per window. Unknown identifiers use the same counters and windows (no account enumeration).
  The route limiters also apply (sign-in 10 failures / 15 min per IP + identifier, OTP limits below).
* **What counts as a failure**: the account lockout counts credential failures only (wrong password,
  PIN, OTP or TOTP code; unknown identifiers alike) and refunds other outcomes (deactivated account,
  blocked device…). The `login` route limiter counts every `≥ 400` answer except the expected **next
  steps** of a sign-in, which both refund like a success: the Super Admin enrolment challenge
  (`200 totp_enrollment_required`) and `401 TOTP_REQUIRED` with `details.reason = TOTP_CODE_MISSING` (right
  password, code not sent yet) — a Super Admin is never throttled by the two-step form.
  `TOTP_CODE_INVALID` (wrong code) and wrong passwords still count against both.

### Sign-in response (all principals)

```json
{
  "success": true,
  "data": {
    "status": "authenticated",
    "tokenType": "Bearer",
    "accessToken": "eyJhbGciOiJIUzI1NiIs…",
    "accessTokenExpiresAt": "2026-10-17T10:15:00.000Z",
    "expiresIn": 900,
    "refreshToken": "nVhB2m…",               // mobile only
    "refreshTokenExpiresAt": "2026-11-16T10:00:00.000Z",
    "sessionId": "01a14ab9-…",
    "mustChangePassword": false,
    "user": { … same as GET /auth/me … }
  }
}
```

## Super Admin

### `POST /auth/platform/login`

```json
{ "email": "superadmin@example.com", "password": "Wimb@12345", "totpCode": "123456" }
```

* TOTP not enrolled yet (first sign-in) → no session, an enrolment challenge (10 minutes):
  ```json
  { "success": true, "data": { "status": "totp_enrollment_required", "challengeToken": "q8Zl…", "challengeExpiresAt": "2026-10-17T10:10:00.000Z" } }
  ```
* Enrolled, `totpCode` missing or wrong → `401 TOTP_REQUIRED` (`details.reason` `TOTP_CODE_MISSING` /
  `TOTP_CODE_INVALID`). A code is accepted once (replay protection per 30-s step). `TOTP_CODE_MISSING`
  (the expected next step after a correct password) and the enrolment challenge do not count against the
  lockout or the `login` limiter; `TOTP_CODE_INVALID` and wrong passwords do.

### `POST /auth/platform/totp/setup`

```json
{ "challengeToken": "q8Zl…" }
```
```json
{ "success": true, "data": { "otpauthUri": "otpauth://totp/Where%20Is%20My%20Bus:superadmin%40example.com?secret=…&issuer=Where%20Is%20My%20Bus", "qrDataUrl": "data:image/png;base64,iVBOR…", "secret": "JBSWY3DPEHPK3PXP", "issuerLabel": "superadmin@example.com" } }
```

### `POST /auth/platform/totp/verify`

```json
{ "challengeToken": "q8Zl…", "code": "492039" }
```
Enables TOTP and returns the sign-in response (`user.totpEnabled: true`). The challenge is single-use.

## School admin — `POST /auth/school/login`

```json
{ "email": "admin@greenwood.example", "password": "Wimb@12345" }
```
E-mail is globally unique. `403 SCHOOL_INACTIVE` for suspended/inactive/deleted schools, `403 FORBIDDEN`
for deactivated accounts (only after a correct password). With `mustChangePassword: true` every other
endpoint answers `403 PASSWORD_CHANGE_REQUIRED` until `POST /auth/change-password`.

## Driver / conductor — `POST /auth/staff/login`

```json
{
  "schoolCode": "GWIS-BLR",
  "phone": "98450 00101",              // or "username": "gwis.driver"
  "password": "Wimb@12345",            // or "pin": "1234"
  "device": { "deviceId": "8f1c…-android-id", "platform": "android", "model": "Pixel 8", "appVersion": "1.0.0", "fcmToken": "…" }
}
```
The device is registered (`devices`) and the session is bound to it. A device blocked by the school →
`403 DEVICE_NOT_BOUND`. Profile includes `staffProfile` and `device`.

### `GET /auth/device` (driver/conductor)

Header `X-Device-Id: 8f1c…-android-id`. `200 { "bound": true, "device": { "id", "deviceUid", "platform", "model", "appVersion" } }`;
any other or missing device id → `403 DEVICE_NOT_BOUND`. Trip and location endpoints use the same check
(`requireBoundDevice()` exported by the auth module).

## Parent

### `POST /auth/parent/otp/request`

```json
{ "phone": "+91 99000 00001" }
```
```json
{ "success": true, "data": { "status": "sent", "expiresInSeconds": 600, "resendAfterSeconds": 60, "codeLength": 6 } }
```
`202` for every valid number — whether or not a school registered it (no enumeration); a code is sent
only to numbers registered by an active school. `expiresInSeconds` and `resendAfterSeconds` come from the
server policy (below; the example shows the defaults) — clients must use the returned values.

**Limits** (all applied identically to registered and unknown numbers):

| Limit | Env key (default) | Exceeded → |
|---|---|---|
| Code expiry | `SMS_OTP_EXPIRY_MIN` (10 min, 1–30) | verify answers `401 OTP_INVALID` |
| Attempts per code | `SMS_OTP_MAX_ATTEMPTS` (5, 1–10) | code locked; verify answers `401 OTP_INVALID` |
| Resend cooldown | `SMS_OTP_RESEND_SECONDS` (60 s, 15–600) | `429 RATE_LIMITED`, `details.reason = OTP_COOLDOWN`, `Retry-After` = seconds left |
| Codes per phone per day | `SMS_OTP_DAILY_CAP` (10, 1–100), Asia/Kolkata calendar day | `429 RATE_LIMITED`, `details.reason = OTP_DAILY_CAP`, `Retry-After` = seconds until local midnight |
| Global daily SMS budget | `SMS_OTP_GLOBAL_DAILY_CAP` (2000), counts real provider sends | `503 SERVICE_UNAVAILABLE` (generic message, `Retry-After` until local midnight) for every number |
| Route limiters | — | 5 requests / hour per phone (`otpRequestPhone`), 20 / hour per IP (`otpRequestIp`) → `429` with `details.limiter` |

Codes: 6 digits, stored only as a hash bound to the phone. The SMS is sent asynchronously: delivery
problems (provider errors, low balance, unsupported number) are logged server-side and never change the
response, and provider messages are never returned to clients.

**Delivery** (`SMS_PROVIDER`):

* `webpayservices` — WebPay Services HTTP API (`SMS_API_URL`, `SMS_API_USERNAME`, `SMS_API_KEY`,
  `SMS_SENDER_ID`, `SMS_ROUTE=OTP`, `SMS_DLT_TEMPLATE_ID`). The text is `SMS_OTP_MESSAGE` with `{otp}`
  replaced; it must match the DLT-registered template exactly. Indian (`+91`) mobile numbers only.
* `console` — development only (refused in production): the message, including the code, is printed in
  the API log.
* **Development allow-list**: outside production, `webpayservices` sends real SMS only to the numbers in
  `SMS_DEV_ALLOWED_NUMBERS` (comma-separated, E.164); for any other number the code is printed in the API
  log (marked "not in SMS_DEV_ALLOWED_NUMBERS"), exactly like the console provider. Production sends to
  every number. Tests always use the console provider with a mocked HTTP client.

**Operational notes**

* OTP SMS consume credits on the WebPay Services **OTP route**. The backend reads the balance with
  `apirequest=CreditCheck&route=OTP` (cached 5 minutes) and logs a warning below
  `SMS_LOW_BALANCE_THRESHOLD` (default 500); the platform health view reads it through the `sms` system
  status check. At zero the provider answers "Low SMS Balance" and every code fails to deliver
  (logged as `LOW_BALANCE`) — recharge before that.
* `SMS_OTP_GLOBAL_DAILY_CAP` bounds worst-case daily spend (e.g. an SMS-pumping attack). When it trips,
  an error is logged once and parent sign-in by code is unavailable until local midnight; raise the cap
  (and restart) if the traffic is legitimate. Parents who set a password can still use the fallback below.
* If `SMS_OTP_MESSAGE` mentions a validity in minutes, keep it equal to `SMS_OTP_EXPIRY_MIN`; the API
  logs a startup warning when they differ.

### `POST /auth/parent/otp/verify`

```json
{ "phone": "+919900000001", "otp": "481920", "device": { "deviceId": "…", "platform": "android" } }
```
Wrong, expired, exhausted and unknown-number codes all answer `401 UNAUTHENTICATED` with
`details.reason = OTP_INVALID`. 10 failed verifications / 15 min per IP + phone → `429`.

### `POST /auth/parent/password-login` (optional fallback)

```json
{ "phone": "+919900000001", "password": "Parent#2026" }
```
Only for parents who set a password (`POST /auth/change-password` without `currentPassword` while none is set).
The parent's password hash and lockout counters live on the global identity and are not readable by
schools (or by the app role in any context): the API reaches them only through scoped SECURITY DEFINER
functions (migration 015).

## Sessions

| Endpoint | Body | Result |
|---|---|---|
| `POST /auth/refresh` | mobile `{ "refreshToken": "…" }`; web: cookie + `X-WIMB-Client: web` | new token pair (same shape as sign-in, without `user`) |
| `POST /auth/logout` | access token, or refresh token / cookie when the access token expired | `{ "loggedOut": true }`; revokes the session family, clears the cookie, disconnects sockets |
| `POST /auth/logout-all` | — (access token) | `{ "revokedSessions": 3 }` — every session of the account |
| `POST /auth/change-password` | `{ "currentPassword": "…", "newPassword": "NewSecret#456" }` | `{ "changed": true, "otherSessionsRevoked": 1 }`; clears `mustChangePassword`; other sessions are signed out |

Password rules: 8–128 characters, at least one letter and one digit, no leading/trailing spaces, different
from the current one. Wrong current password → `400 VALIDATION_ERROR` on `currentPassword`.

Mobile clients should send `X-Device-Id` on `POST /auth/refresh` too (the driver and parent apps send it on
every call), so a concurrent or retried refresh gets the grace answer described above.

Refresh failures: `401 UNAUTHENTICATED` with `details.reason` ∈ `UNKNOWN_TOKEN`, `MISSING_TOKEN`,
`CLIENT_MISMATCH`, `REVOKED`, `EXPIRED`, `REFRESH_TOKEN_REUSED`, `ACCOUNT_INACTIVE`; `403 SCHOOL_INACTIVE`.

Refresh rate limits (`429 RATE_LIMITED`, `Retry-After`, `details.limiter`): `refresh` — 30 per 15 minutes per
refresh token (one session; web cookie and mobile body token share the bucket); `refreshIp` — 3000 per
15 minutes per IP address, a ceiling sized for a school office or a carrier NAT with many devices.

## Realtime (`/rt`) and long-lived sockets

Connect with `auth: { token: <accessToken> }`. The handshake verifies the token and its session. After that
the socket is bound to the **session**, not to the 15-minute token: every `join` re-loads the live session
(revoked or expired session, deactivated account, changed role/school → `UNAUTHENTICATED` and disconnect;
closed school → `SCHOOL_INACTIVE` and disconnect) and runs the room's authorizer (`FORBIDDEN` otherwise).
Logout, logout-all, password changes, deactivations and refresh-token reuse disconnect the affected
sockets immediately.

After `POST /auth/refresh`, a client may move its socket to the new session without reconnecting:
```js
socket.emit('auth:refresh', { token: newAccessToken }, (ack) => { /* { ok: true, sessionId, tokenExpiresAt } */ });
```
Only a token of the **same** account, role and school is accepted (`{ ok: false, error: { code: 'FORBIDDEN' } }`
otherwise); an invalid or expired token answers `UNAUTHENTICATED` and the socket keeps its current session.
Rooms: `school:{id}:fleet`, `school:{id}:alerts` (school admins of that school), `trip:{tripId}`,
`child:{studentId}:live` (tracking module) — see contract §7.

## `GET /auth/me`

* **super_admin**: `{ "id", "role": "super_admin", "name", "email", "totpEnabled", "mustChangePassword", "lastLoginAt" }`
* **school_admin / driver / conductor**:
  ```json
  { "id": "…", "role": "driver", "name": "Ravi Kumar", "email": null, "phone": "+919845000101", "username": "gwis.driver",
    "mustChangePassword": false, "lastLoginAt": "…",
    "school": { "id": "…", "code": "GWIS-BLR", "name": "Greenwood International School", "institutionType": "school",
                "brandColor": "#1B7F3B", "timezone": "Asia/Kolkata", "city": "Bengaluru", "state": "Karnataka",
                "location": { "lat": 12.933756, "lng": 77.62275 }, "status": "active", "logoUrl": "https://…signed…",
                "privacyUrl": "https://greenwood.example.edu/privacy", "termsUrl": null },
    "staffProfile": { "id": "…", "staffType": "driver", "photoFileId": null },
    "device": { "id": "…", "platform": "android", "model": "Pixel 8", "appVersion": "1.0.0" } }
  ```
  (`staffProfile`/`device` for drivers and conductors only; `403 SCHOOL_INACTIVE` when the school is not active.)
* **parent** (children index grouped by school; children of non-active schools are not listed):
  ```json
  { "id": "…", "role": "parent", "name": "Vikram Mehta", "phone": "+919900000001", "preferredLanguage": "en", "hasPassword": false,
    "consentRequired": true,
    "schools": [
      { "school": { "id": "…", "code": "GWIS-BLR", "name": "Greenwood International School", "logoUrl": null,
                    "privacyUrl": "https://greenwood.example.edu/privacy", "termsUrl": null, … },
        "children": [{ "id": "…", "fullName": "Aarav Mehta", "className": "5", "section": "A", "photoFileId": null }],
        "consent": { "requiredVersion": "2", "acceptedVersion": "1", "acceptedAt": "…", "consentRequired": true } },
      { "school": { "code": "SUNRISE-JPR", … }, "children": [{ "fullName": "Isha Mehta", … }],
        "consent": { "requiredVersion": "1", "acceptedVersion": "1", "acceptedAt": "…", "consentRequired": false } } ] }
  ```
  `consentRequired` (top level) is true when any active school needs (re-)consent: show the consent screen and
  accept per school with `POST /parent/consent` ([privacy.md](privacy.md)); `consent` is `null` for a school that
  is not active. `privacyUrl` / `termsUrl` are the school's effective links (school override or platform value).

Public, before sign-in: `GET /auth/legal` (platform privacy policy / terms links and consent version) and
`GET /auth/school/branding?code=` (name, logo, colour, type and links of an active school) — see
[privacy.md](privacy.md).

## Audit

Sign-ins, failures, lockouts, TOTP enrolment, logouts, password changes and refresh-token reuse are
written to the audit log of the actor's scope (school log for school users, platform log for super
admins). Parent sign-ins are logged by the application logger with the phone masked, not in `audit_logs`
(see `docs/api/audit.md`).

## For module builders

```ts
import { requireBoundDevice, revokeAllSessions } from '../auth/index.js';
router.post('/driver/trips/:id/locations', ...guards.staff(), requireBoundDevice(), handler); // req.boundDevice.id
const ids = await revokeAllSessions(tx, 'user', userId, 'deactivated');                         // in the same tx
await realtime.disconnectSessions(ids);                                                            // after commit
```
