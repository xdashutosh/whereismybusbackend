# Privacy and data protection (BP §16)

What the platform stores about children, parents and staff, who is responsible for it, how long it is
kept, and how schools answer data requests. **Not legal advice**: have counsel review the DPA,
the privacy policies and the consent text before onboarding a school (BP §16 "Confirm with legal counsel").

## 1. Roles under India's DPDP Act 2023

| Party | Role | Responsibilities |
|---|---|---|
| Each school / college / university | **Data fiduciary** | Decides why and how student, parent and staff data is used; collects **verifiable parental consent** for children (DPDP s.9: under 18); answers parents' access, correction and erasure requests; names a contact for grievances. |
| The platform operator (Where Is My Bus) | **Data processor** for the school | Processes data only on the school's documented instructions (the DPA); keeps it secure; helps the school answer requests; deletes or returns data when the contract ends; reports breaches to the school without delay. |
| Sub-processors (§3) | Processors engaged by the operator | Bound by their own terms; listed in the DPA so schools can object. |

The operator signs a **Data Processing Agreement** with every school before go-live, covering: subject
matter and duration, data categories (§2), purposes (transport safety and parent notifications only — no
advertising, no profiling, no sale), sub-processors (§3), security measures (§5), retention (§4),
assistance with data principal requests (§6), breach notification (operator → school within 24 h of
discovery, so the school can notify the Data Protection Board and affected people), and return/deletion
at the end of the contract.

## 2. Data inventory

| Data | About | Source | Used for |
|---|---|---|---|
| Name, admission no., class/section, roll no., optional photo, bus/route/stop assignment | Students (children) | School admin (form or CSV import) | Rosters, parent app, trip manifests |
| Name, mobile number, preferred language, sign-in sessions and devices, push token | Parents | School admin; the parent at OTP sign-in | Sign-in by SMS OTP, notifications, live bus view |
| Name, phone/username, licence and identity documents, photo, device | Drivers, conductors | School admin | Sign-in, trips, document expiry reminders |
| Name, e-mail, password hash, TOTP secret (super admin) | Admins | Platform / school admin | Admin panels |
| **Bus** GPS fixes during trips (position, speed, heading, accuracy, phone battery and network type) | The bus — indirectly the crew and the children on board | Driver app, background location during a trip only | Live map, ETAs, stop arrivals, trip reports |
| Odometer photos, fuel bills, maintenance invoices | Bus operations | Driver app / admin | Fleet records |
| Audit log (actor, action, IP address, user agent, before/after values) | Admins, staff, parents | Every write | Accountability, security investigations |
| Consent records (school, version accepted, time, links in force, app name/version, IP address, user agent) | Parents | The parent app (`POST /parent/consent`) | Evidence of verifiable parental consent per school (DPDP s.9) |

The parent app does not collect the parent's or the child's location. Battery and network type reach
admins only, never parents (`docs/api/tracking.md`). Parents' global identity columns (password hash,
lockout state) are hidden from schools by column privileges (migration 015).

## 3. Where data is stored (sub-processors)

| Sub-processor | Purpose | Location |
|---|---|---|
| Neon (PostgreSQL) | Primary database | AWS us-east-1 (USA) |
| Render | API, jobs worker, Redis (live state, queues) | Virginia (USA) |
| Vercel | Web admin static files; proxies admin API calls | Global edge |
| Akamai / Linode Object Storage | Files (photos, documents) in a **private** bucket | in-maa-1, Chennai (India) |
| WebPay Services | SMS OTP delivery (parent phone number + code) | India |
| Google Maps Platform | Maps, routing (stop coordinates, bus positions on the client) | Global |
| Firebase Cloud Messaging (optional) | Push notifications (device token + message) | Global |
| SMTP provider (optional) | Admin e-mails | Provider's region |

DPDP allows transfers outside India except to countries the government restricts by notification; check
the current list before go-live and state the US hosting in the DPA and both privacy policies. Moving the
database and API to an Indian region (Neon `aws-ap-south-1`, Render Singapore is the nearest Render region)
is a configuration change (`docs/DEPLOYMENT.md`), not a code change.

## 4. Retention (implemented today)

| Data | Kept | Mechanism |
|---|---|---|
| Raw GPS points | 12 months (platform setting `location.retention_months`, the maximum); a school may choose fewer months (`locationRetentionMonths` in school settings) | `partition-maintenance` job drops monthly partitions and deletes a school's older points at its own cutoff, after storing the simplified path of trips that had none (BP §9.6) |
| Coordinates of driver-app device events (trip timeline) | Same cutoff as the school's GPS points; the event itself stays | `partition-maintenance` job (migration 926) |
| Trip summaries, reports | While the school is a customer | — |
| Expired / revoked sessions | 30 days after expiry | `session-cleanup` job |
| OTP codes | 1 day after expiry | `session-cleanup` job |
| Incomplete uploads (`.part`) | 24 hours | `files-staging-cleanup` job |
| Replaced documents | Kept for audit (`is_current = false`) | BP §12 |
| Soft-deleted students / parents / staff | Row kept with `deleted_at` (links and sessions removed) | Module services |
| Erased students / parents | Row kept anonymised (`erased_at`; name replaced, contact data cleared, photos deleted) for aggregate integrity | `POST /school/privacy/{students\|parents}/:id/erase` |
| Parent consent records | While the school is a customer; IP address and user agent nulled when the parent is erased | `parent_consents` (migration 901) |
| Audit log | While the school is a customer | — |

Per-school retention (BP §12, §20 #11): GPS history can be shortened per school through the API (`PUT /school/settings`
`locationRetentionMonths`, capped at the platform value; web: School settings → Location tracking).
Replaced documents and uploaded photos are kept for audit (product decision) and are not purged per school.

## 5. Security measures (summary for the DPA)

Row-level security on every tenant table with a non-bypass runtime role; tenant isolation tests in CI;
TLS everywhere; private bucket with short-lived presigned URLs; Argon2id password hashes; SMS OTP with
attempt limits and daily caps; TOTP for the super admin; per-IP and per-account rate limits; secrets only in
the hosting providers' environment settings; audit logging of every write; logs redact tokens, passwords
and OTPs. Details: `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`.

## 6. Data principal requests — what the school can do

API reference: [`api/privacy.md`](api/privacy.md). Every action below runs in the school admin's own tenant context
(another school's ids answer `404`) and is audited.

| Request | How | Notes |
|---|---|---|
| Access / export | `GET /school/privacy/students/:id/export`, `GET /school/privacy/parents/:id/export` — one JSON document (`wimb.privacy-export`, format v1): profile, links, assignments (history), notification preferences, inbox, notification events, consent records, the school trips with the stop events at the child's stop | Audited as `privacy.export` (counts only). Raw GPS points describe the bus and are summarised by the trip rows. The student list CSV export stays available. |
| Correction | Edit student, parent (phone correction), staff in the admin panel | — |
| Erasure | `POST /school/privacy/{students\|parents}/:id/erase` with `{ "confirm": "ERASE" }` — **irreversible** anonymisation: names replaced, contact data, notes and photos removed (photos deleted from object storage), links, preferences and inbox rows deleted, consent network details nulled; trips, stop events, GPS points, alerts, reports and the audit trail stay (pseudonymous ids) | A parent's **global** identity (phone, sessions, push tokens) is anonymised only when no other school has a live link to it — one school never changes data another school relies on, and the response never says which case applied. Audited as `privacy.erase` (counts only). Soft delete / removal (`DELETE /school/students/:id`, `DELETE /school/parents/:id`) remain the reversible options. |
| Consent / withdraw consent | Parents accept per school in the parent app (`POST /parent/consent`); the record keeps the version, time, links, app and network details. Withdrawal: the school removes or erases the parent | Changing `legal.consent_version` (platform) or the school's `consentVersion` asks every affected parent again (`consentRequired`). |
| Grievance / policy | Privacy policy and terms links: platform settings `legal.privacy_url`, `legal.terms_url` with a per-school override (`privacyPolicyUrl`, `termsUrl`), returned by `/auth/legal`, `/auth/school/branding`, `/auth/me` and `/parent/consent` for the apps' sign-in, Settings/Profile and consent screens | The school's own contact for grievances belongs in its privacy policy. |

What erasure does not rewrite: earlier audit rows (the audit log is insert-only accountability data; its old/new
values may still contain the former name), bulk files that mention many people (CSV imports, generated reports) and
idempotency replay records (expire after 24 h). If counsel requires those to be scrubbed as well, the operator does it
as a reviewed, recorded support task.

## 7. Status of the privacy features

Built in the API (migrations 900–901, `backend/src/modules/privacy/`, [`api/privacy.md`](api/privacy.md)):
privacy policy / terms links (platform + per-school override, https only), public school branding with the links,
parent consent records per school with re-consent after a version bump, per-person export and erasure, tenant
isolation tests for all of it (`backend/tests/privacy.*.test.ts`).

Application work outside the backend:
1. **Apps** (done, `parentapp/README.md`, `driverapp/README.md`): the links on both apps' sign-in screens
   (parent: `GET /auth/legal`; driver: `GET /auth/school/branding?code=` with the school's name and logo), in the
   parent app Settings and the driver app Profile; the parent app's consent screen whenever `consentRequired` is
   true (first use and after a version bump; the rest of the app stays locked, sign out stays available;
   `POST /parent/consent` per school). **Web** (done, `admin/README.md`): the links on the sign-in pages and in
   the school account menu, the platform "Privacy & legal" settings and the school's legal tab, and the export /
   erasure buttons on the student and parent pages (erasure needs the typed confirmation). The Play Store and App
   Store listings need the platform privacy URL at submission.
2. **Per-school retention**: done for GPS points in the API (migration 800); photos and replaced documents are
   deliberately kept for audit (erasure deletes a person's photos).

The driver app already shows the prominent background-location disclosure that store review requires.
