# Staff API (drivers & conductors)

Blueprint §6.2 (`staff_profiles`, `staff_documents`, `bus_staff_assignments`), §5.1/§5.4 (staff logins),
§8.3 (Staff), §12 (files), §13.3 (Staff screen, parent-visibility preview), §16 (data minimisation); contract §5, §6.
Base `/api/v1`. Source: `backend/src/modules/staff/`; shared Zod schemas and DTO types:
`backend/shared/src/schemas/staff.ts` (`@wimb/shared`). Profile and credential bodies are validated in the backend
(`schemas.ts`) because phone numbers are normalised with libphonenumber (`98450 12345` → `+919845012345`).

* **School admins only** (`/school/*` area guard + route guard). Drivers, conductors and parents get `403`.
* Ids of another school answer `404 NOT_FOUND` on every endpoint; `school_id` in a body is ignored.
* Every write is audited in the same transaction: `staff.create|update|activate|deactivate|delete`,
  `staff.credentials_create|credentials_reset`, `staff_document.create|replace|update|visibility|verify|delete`.
  Audit entries never contain passwords, PINs, the address or full identity numbers.
* Creates accept `Idempotency-Key` (`POST /school/staff`, `POST …/documents`, `PUT /school/staff-documents/:docId`).
  `POST …/credentials` deliberately does **not** (its response carries one-time secrets and is `Cache-Control: no-store`).
* Photos and document scans are uploaded first through the files module (`POST /files/upload` on the web,
  `POST /files/upload-url` + `complete` on mobile — see [files.md](files.md)) with category `staff_photo` /
  `staff_document`, `entityType: "staff"` and the staff id; the returned `fileId` is then linked here.
* **Data minimisation (BP §16).** Identity proofs store the **type and the last 4 characters only**
  (`idProofLast4`); values that look like a full Aadhaar (12 digits) or PAN (`ABCDE1234F`) are refused with
  `400` (the value is never echoed), and unknown keys such as `aadhaarNumber` are dropped. Responses show
  `idProofMasked` (`XXXX XXXX 1234`). The address and emergency contact are internal (admin detail only).

| Method | Path | Purpose |
|---|---|---|
| GET | `/school/staff` | List (`type=driver\|conductor`, filters, sort, pagination, `format=csv`) |
| POST | `/school/staff` | Create a driver or conductor profile |
| GET | `/school/staff/:id` | Detail: profile + photo + login state + current assignments + current documents |
| PATCH | `/school/staff/:id` | Edit (partial; photo via `photoFileId`) |
| DELETE | `/school/staff/:id` | Soft delete (history kept; login removed; sessions revoked) |
| POST | `/school/staff/:id/credentials` | Create the app login, or reset it (temporary password / PIN) |
| POST | `/school/staff/:id/activate` | Re-enable profile and login |
| POST | `/school/staff/:id/deactivate` | Disable: end assignments, disable login, revoke sessions |
| POST | `/school/staff/:id/sessions/revoke` | Sign out of every device (credentials unchanged) |
| GET | `/school/staff/:id/assignment-history` | Bus assignment history (`format=csv`) |
| GET | `/school/staff/:id/parent-preview` | What a parent would see under the school's visibility matrix |
| GET | `/school/staff/:id/documents` | Documents (current; `includeHistory=true` adds replaced versions) |
| POST | `/school/staff/:id/documents` | Add a document |
| GET | `/school/staff-documents/:docId` | Document + all its versions |
| PUT | `/school/staff-documents/:docId` | Replace (new current version, history kept) |
| PATCH | `/school/staff-documents/:docId` | Correct metadata of this version |
| PATCH | `/school/staff-documents/:docId/visibility` | Parent visibility flags |
| PATCH | `/school/staff-documents/:docId/verify` | Verification status |
| DELETE | `/school/staff-documents/:docId` | Soft delete |

## Staff object (list item)

```json
{
  "id": "019a0b7e-…", "staffType": "driver", "fullName": "Ravi Kumar", "phone": "+919845000101", "email": null,
  "photoFileId": "019a0b80-…", "photoThumbnailUrl": "https://…signed…",
  "joiningDate": "2023-06-01", "experienceYears": 9, "idProofType": "aadhaar", "idProofMasked": "XXXX XXXX 4100",
  "idVerificationStatus": "verified", "licenceNo": "KA0120190012345", "licenceExpiryDate": "2028-04-10",
  "licenceStatus": "valid", "licenceDaysToExpiry": 540, "licenceVerificationStatus": "verified",
  "isActive": true, "hasLogin": true, "loginPhone": "+919845000101", "loginUsername": "gwis.driver",
  "currentBuses": [{ "busId": "019a…", "busCode": "R1", "role": "primary_driver" }],
  "expiredDocuments": 0, "expiringDocuments": 1, "createdAt": "…", "updatedAt": "…"
}
```
`licenceStatus` / document `expiryStatus`: `valid` · `expiring` (within 30 days, school-local date) · `expired` · `none`
(no date). `idProofType`: `aadhaar` `pan` `voter_id` `passport` `driving_licence` `other`.
`verificationStatus` values: `pending` `verified` `rejected`. Assignment roles: `primary_driver` `backup_driver`
`conductor` `backup_conductor`.

## `GET /school/staff`

Query: `page`, `limit` (1–100, default 20), `sort` (`fullName` default; `staffType`, `joiningDate`, `experienceYears`,
`licenceExpiryDate`, `isActive`, `createdAt`, `updatedAt`; `-` for descending), `q` (name, phone, licence number,
username), `type` (`driver`, `conductor`, comma separated), `status` (`active` | `inactive` | `all`, default all),
`licenceStatus` (`expired` | `expiring` | `missing` — drivers without a licence expiry), `documentStatus`
(`expired` | `expiring`: at least one current document in that state), `hasLogin` (bool), `assigned` (bool: currently
assigned to a bus), `format=csv` (all matching rows, max 10 000; identity numbers masked, no address).

```
GET /api/v1/school/staff?type=driver&licenceStatus=expiring&sort=licenceExpiryDate
→ 200 { "success": true, "data": [ { …staff… } ], "meta": { "page": 1, "limit": 20, "total": 2, "totalPages": 1 } }
```

## `POST /school/staff`

```json
{
  "staffType": "driver",
  "fullName": "Prakash Rao",
  "phone": "98450 33333",
  "email": "prakash@example.com",
  "address": "12 MG Road, Bengaluru",
  "joiningDate": "2024-04-01",
  "experienceYears": 12.5,
  "experienceSummary": "School buses since 2014",
  "emergencyContactName": "Sita Rao",
  "emergencyContactPhone": "+919845044444",
  "idProofType": "aadhaar",
  "idProofLast4": "1234",
  "licenceNo": "KA01 2014-0098765",
  "licenceRto": "KA-01 Bengaluru Central",
  "licenceIssueDate": "2014-03-01",
  "licenceExpiryDate": "2034-02-28"
}
```
Only `staffType` and `fullName` are required. Rules: licence fields are for drivers only (`400` on a conductor);
`licenceExpiryDate ≥ licenceIssueDate`; `idProofLast4` (exactly 4 letters/digits, upper-cased) needs `idProofType`;
`licenceNo` is upper-cased with spaces/hyphens removed (6–20 characters); `experienceYears` 0–60 (one decimal).
`201` → the staff detail (below). The staff type never changes afterwards (`PATCH` with `staffType` → `400`).
The photo is linked after creation (the upload needs the staff id): upload a `staff_photo` and `PATCH` its id.

## `GET /school/staff/:id` — detail

The list item plus:

```json
{
  "address": "12 MG Road, Bengaluru", "experienceSummary": "School buses since 2014",
  "emergencyContactName": "Sita Rao", "emergencyContactPhone": "+919845044444",
  "idProofLast4": "1234", "licenceRto": "KA-01 Bengaluru Central", "licenceIssueDate": "2014-03-01",
  "photo": { "fileId": "019a…", "url": "https://…signed…", "thumbnailUrl": "https://…signed…" },
  "login": {
    "userId": "019a…", "phone": "+919845033333", "username": "prakash.r", "hasPin": true, "isActive": true,
    "mustChangePassword": true, "locked": false, "lastLoginAt": null, "passwordChangedAt": null, "activeSessions": 0
  },
  "currentAssignments": [ { …assignment history item… } ],
  "documents": [ { …document… } ],
  "activeTripId": null,
  "createdBy": "019a…"
}
```
`login` is `null` until credentials are created. `activeTripId` is the in-progress trip the staff member drives or
conducts. Photo URLs are presigned (≤ 300 s).

## `PATCH /school/staff/:id`

Any subset of the create fields (except `staffType`) plus `photoFileId` (a `staff_photo` uploaded **for this staff
member**, status uploaded, not attached elsewhere; `null` removes the photo). Empty strings clear optional fields.
Changing `fullName` also renames the login; the contact `phone` is independent of the login phone (change that with
`/credentials`). `200` → detail. Errors: `400` (`photoFileId` of another record or
category, licence fields on a conductor, licence dates out of order), `409 CONFLICT` (file already attached).

## `POST /school/staff/:id/credentials` — create or reset the app login

Drivers and conductors sign in to the driver app with **school code + phone or username + password or PIN**
(`POST /auth/staff/login`, [auth.md](auth.md)). This endpoint creates the login when the staff member has none
(`201`) and otherwise resets it (`200`).

```json
{ "phone": "+919845033333", "username": "prakash.r", "password": "Bus#Route2026", "pin": "4829", "generatePin": false, "mustChangePassword": true }
```
All fields are optional:

| Field | Meaning |
|---|---|
| `phone` | Login phone (E.164 after normalisation). Omitted: the profile phone for a new login, unchanged on a reset. `null`: no phone sign-in. |
| `username` | 3–40 letters, digits, `.`, `_`, `-`. Omitted: none for a new login, unchanged on a reset. `null` removes it. |
| `password` | Temporary password (auth password rules). Omitted → generated (`Kmtp-Wqra-4827`) and returned once. |
| `pin` | 4–6 digits; one repeated digit (`1111`) and digit runs (`1234`, `9876`) are refused. |
| `generatePin` | `true` → a random 6-digit PIN is generated and returned once (not together with `pin`). |
| `mustChangePassword` | Force a password change at the next sign-in (default `true`). |

A login needs a phone or a username (`400` otherwise). Phone and username are unique among the drivers/conductors of
the school (`409 DUPLICATE`); other schools may reuse them.

**A reset replaces every secret**: the password (given or generated) and the PIN (given, generated, or removed when
neither `pin` nor `generatePin` is sent); it clears the lockout counters and **revokes every session** of the login in
the same transaction, then disconnects its sockets. Old passwords, PINs, access and refresh tokens stop working at once.

```json
{
  "success": true,
  "data": {
    "created": true,
    "temporaryPassword": "Kmtp-Wqra-4827",
    "pin": "583027",
    "revokedSessions": 0,
    "login": { "userId": "019a…", "phone": "+919845033333", "username": null, "hasPin": true, "isActive": true, "mustChangePassword": true, "locked": false, "lastLoginAt": null, "passwordChangedAt": null, "activeSessions": 0 },
    "staff": { …detail… }
  }
}
```
`temporaryPassword` / `pin` are present only when the server generated them — share them with the staff member
securely; they cannot be retrieved again (only argon2id hashes are stored). The login inherits the profile's active
state (a deactivated staff member gets an inactive login).

## `POST /school/staff/:id/deactivate` · `POST /school/staff/:id/activate`

Deactivate body: `{ "reason": "Left the job" }` (optional, audited). In one transaction: the profile becomes inactive,
every open or future bus assignment is ended now (history kept), the login is disabled and all its sessions are
revoked; sockets are disconnected after commit. Deactivation never deletes anything (BP §5.4).

```json
{ "success": true, "data": { …detail…, "isActive": false, "revokedSessions": 2, "closedAssignments": 1 } }
```
Repeating it is a no-op (`revokedSessions: 0`). **Refused while the staff member drives or conducts a trip in
progress**: `409 INVALID_STATE` with `details: { "reason": "ACTIVE_TRIP", "tripId": "…" }` — end the trip first.

Activate re-enables the profile and its login (`200` → detail); ended assignments stay ended (assign again on the bus,
`POST /school/buses/:id/assign-staff`).

## `POST /school/staff/:id/sessions/revoke` — sign out all devices

BP §5.2 force logout (e.g. a lost phone) that keeps the login, PIN/password, assignments and profile as they are.
No body. All sessions of the staff member's login are revoked and its sockets disconnected after commit; audited as
`staff.sessions_revoke`. → `200 { "id": "…", "revokedSessions": 2 }` (`0` when there was no login or no session).
Unknown id → `404`.

## `DELETE /school/staff/:id`

Soft delete: the profile disappears from the API, open assignments are ended, the login is soft-deleted (its phone
and username become free again) and its sessions are revoked. Trips, assignment history, documents and audit entries
keep the id. Refused during a trip in progress (`409 INVALID_STATE`, `ACTIVE_TRIP`).

```json
{ "success": true, "data": { "id": "019a…", "deleted": true, "revokedSessions": 1, "closedAssignments": 1 } }
```

## `GET /school/staff/:id/assignment-history`

Bus assignments written by `POST /school/buses/:id/assign-staff` ([buses.md](buses.md)) and closed by deactivation.
Query: `page`, `limit`, `sort` (`-validFrom` default; `validTo`, `busCode`, `role`, `createdAt`), `role` (comma list),
`busId`, `current` (bool), `format=csv`.

```json
{
  "id": "019a…", "busId": "019a…", "busCode": "R2", "busName": "Route 2 Bus", "registrationNo": "KA01AC2318",
  "role": "conductor", "validFrom": "2026-09-18T02:10:00.000Z", "validTo": "2026-10-18T02:44:00.000Z",
  "isCurrent": false, "createdBy": "019a…", "createdByName": "Meera Iyer", "createdAt": "…"
}
```
Windows are half-open: `validFrom` inclusive, `validTo` exclusive (`null` = open).

## `GET /school/staff/:id/parent-preview`

Exactly the card a parent of a child on this staff member's bus would see (BP §13.3 live preview), under the school's
current matrix (`GET/PUT /school/settings/parent-visibility`, section `driver` or `conductor`) and the documents' own
flags. Changes to the matrix or to a document's flags show up immediately.

```json
{
  "staffId": "019a…", "staffType": "driver",
  "visibleToParents": true, "hiddenReasons": [],
  "buses": [{ "busId": "019a…", "busCode": "R1", "role": "primary_driver" }],
  "matrix": { "photo": true, "phone": false, "email": false, "experience": true, "licenceValidity": true, "licenceFile": false, "training": true, "characterCertStatus": true, "verification": true },
  "hiddenFields": ["phone", "email", "licenceFile"],
  "hiddenDocuments": [{ "documentId": "019a…", "docType": "identity", "reason": "IDENTITY" }],
  "card": {
    "id": "019a…", "staffType": "driver", "fullName": "Ravi Kumar",
    "photo": { "fileId": "019a…", "url": "https://…signed…", "thumbnailUrl": "https://…signed…" },
    "phone": null, "email": null,
    "experience": { "years": 9, "summary": "Heavy passenger vehicle licence; …", "joiningDate": "2023-06-01" },
    "licence": { "expiryDate": "2028-04-10", "expiryStatus": "valid", "verificationStatus": "verified" },
    "verification": { "identity": "verified", "policeVerification": "verified" },
    "documents": [
      { "docType": "licence_front", "title": "Driving licence (front)", "verificationStatus": "verified", "expiryDate": "2028-04-10", "expiryStatus": "valid", "fileId": null },
      { "docType": "police_verification", "title": "Police verification certificate", "verificationStatus": "verified", "expiryDate": "2027-03-31", "expiryStatus": "valid", "fileId": null },
      { "docType": "character_certificate", "title": "Character certificate", "verificationStatus": "pending", "expiryDate": null, "expiryStatus": "none", "fileId": null }
    ]
  }
}
```
`hiddenReasons`: `INACTIVE` (deactivated staff are never shown) and/or `NOT_ASSIGNED` (parents only see staff currently
assigned to their child's bus). `hiddenDocuments[].reason`: `IDENTITY` (never shown), `SCHOOL_SETTING` (the matrix
hides this type), `DOCUMENT_FLAGS` (the document's own flags hide it), `NOT_VERIFIED` (the document offers only its file —
`visibleToParentsFile` on, `visibleToParentsStatus` off — and the matrix allows files, but it is pending or rejected:
files of unverified documents are never shown to parents).

**Matrix → card** (the card never contains the address, emergency contact, identity numbers, licence number or login):

| Matrix flag | Card content |
|---|---|
| `photo` | `photo` (signed URLs) |
| `phone` / `email` | contact phone / e-mail of the profile |
| `experience` | years, summary, joining date |
| `licenceValidity` (drivers) | licence expiry + status (only for a verified licence) + verification; status of `licence_front/back` documents |
| `licenceFile` (drivers) | `fileId` of licence documents whose `visibleToParentsFile` is on |
| `characterCertStatus` | `character_certificate` status (and its file when the document allows it) |
| `verification` | identity verification result, police verification status, `police_verification` document |
| `training` | `training`, `first_aid`, `child_safety` documents |
| — | `other` documents follow their own flags; `identity` documents are never shown |

A document's status needs its `visibleToParentsStatus` **and** the matrix flag; its file needs `visibleToParentsFile`
**and** the file flag of its type.

**Verification.** Validity (`expiryDate`, `expiryStatus`) and files are shown only for a **current, verified**
document; replaced versions never appear and their verdict never carries over to a renewal. A `pending` or `rejected`
document whose status the flags allow stays on the card as **not verified**: its `verificationStatus` with
`expiryDate: null`, `expiryStatus: "none"` and `fileId: null` — apps show it as "Not verified", never as valid. A
document allowed only for its file is left out until it is verified. The licence summary (`card.licence`) follows the
same rule: `expiryDate`/`expiryStatus` only while the licence is verified, i.e. the profile's
`licenceVerificationStatus` is `verified` and no current `licence_front`/`licence_back` document is pending or rejected
(e.g. a renewal waiting for verification); otherwise `verificationStatus` is `pending`/`rejected`, `expiryDate` is
`null` and `expiryStatus` is `"none"`. `verification.identity` / `policeVerification` are verification results and
are shown as they are.

The parent module renders the same card for
`GET /parent/children/:studentId/staff` through the exported `parentStaffForBus(req, tx, busId)` /
`parentStaffCard(req, tx, staffId)` (`backend/src/modules/staff/index.ts`), with RLS as the backstop.

## Documents

Types: `identity`, `licence_front`, `licence_back` (drivers only), `character_certificate`, `police_verification`,
`training`, `first_aid`, `child_safety`, `other`. One **current** document per type and staff member, except
`training` and `other` (several allowed); a second one → `409 CONFLICT` with `details.documentId` of the current one
(replace it instead).

### Document object

```json
{
  "id": "019a…", "staffId": "019a…", "docType": "police_verification", "title": "Police verification certificate",
  "issuer": "Bengaluru City Police", "docNumber": "PV/2025/1040", "issueDate": "2024-10-01", "expiryDate": "2027-03-31",
  "expiryStatus": "valid", "daysToExpiry": 164,
  "file": { "id": "019a…", "fileName": "pv.pdf", "contentType": "application/pdf", "sizeBytes": 48211, "hasThumbnail": false },
  "verificationStatus": "verified", "verifiedBy": "019a…", "verifiedByName": "Meera Iyer", "verifiedAt": "…", "verificationNote": null,
  "visibleToParentsStatus": true, "visibleToParentsFile": false,
  "isCurrent": true, "replacedBy": null, "createdAt": "…", "updatedAt": "…"
}
```
`file` is a reference: admins open it with `GET /files/:id/url` (presigned, 60–300 s).

### `GET /school/staff/:id/documents`
Query: `docType` (comma list), `includeHistory` (bool). Order: identity, licence front/back, police verification,
character certificate, child safety, first aid, training, other; current before replaced, newest first.

### `POST /school/staff/:id/documents`
```json
{ "docType": "licence_front", "title": "DL front", "issuer": "RTO Bengaluru", "docNumber": "KA0120140098765",
  "issueDate": "2014-03-01", "expiryDate": "2034-02-28", "fileId": "019a…", "visibleToParentsStatus": true, "visibleToParentsFile": false }
```
`docType` required. `fileId`: a `staff_document` uploaded for this staff member (uploaded, not attached elsewhere).
Defaults: `visibleToParentsStatus: true`, `visibleToParentsFile: false`. `expiryDate ≥ issueDate`.
**Identity documents** are admin-only: both visibility flags are forced off (`true` → `400`) and `docNumber` may only
hold the last 4 characters. No document may store a full Aadhaar/PAN number (`400`, value not echoed). `201` → document.

### `GET /school/staff-documents/:docId`
The document plus `versions` (every version linked through `replacedBy`, newest first).

### `PUT /school/staff-documents/:docId` — replace
Body: the create fields without `docType`. Creates a new current version (`201`); the old one gets `isCurrent: false`
and `replacedBy`. `fileId` omitted → the new version keeps the previous file (`null` → none); visibility flags default
to the previous version's; verification starts again at `pending` (parents see the renewal as not verified — no
validity, no file — until it is verified). Only the current version can be replaced (`409 INVALID_STATE`).

### `PATCH /school/staff-documents/:docId`
Corrects `title`, `issuer`, `docNumber`, `issueDate`, `expiryDate` of this version (no new version). `200` → document.

### `PATCH /school/staff-documents/:docId/visibility`
`{ "visibleToParentsStatus": true, "visibleToParentsFile": true }` (at least one). Identity documents → `400`.
What parents finally see also depends on the school matrix and on the document's verification (see the preview above).

### `PATCH /school/staff-documents/:docId/verify`
`{ "status": "verified" | "rejected" | "pending", "note": "…" }` — a note is required when rejecting. Sets
`verifiedBy`/`verifiedAt` (cleared for `pending`). Verifying the current **identity** document also sets the profile's
`idVerificationStatus`; verifying a current **licence** side sets `licenceVerificationStatus`. Parents see a document's
validity and file only while it is `verified` (see the parent preview above).

### `DELETE /school/staff-documents/:docId`
Soft delete; the stored file is kept for audit (BP §12). `200` → `{ "id": "…", "deleted": true }`.

## File access (`GET /files/:id/url`, hooks in `backend/src/modules/staff/fileHooks.ts`)

| Caller | `staff_photo` | `staff_document` |
|---|---|---|
| School admin | every file of the school | every file of the school |
| Driver / conductor | own current photo | own live documents |
| Parent (`X-School-Id`) | photo of an **active** staff member currently assigned to one of their children's buses, when the matrix flag `photo` of that staff type is on | current, **verified**, non-identity document of such a staff member with `visibleToParentsFile` **and** the matrix file flag of its type (never for `pending`/`rejected` documents or replaced versions, even with every flag on) |

Everything else answers `404`. Uploads (`staff_photo`, `staff_document`) are for school admins and need a live staff
profile of the school as entity (`entityType: "staff"`). RLS (`parent_scope` on `files`, `staff_profiles`,
`staff_documents`) is the database backstop.

## Demo data (seed `40_staff`)

`npm run seed` gives every demo school 6 drivers and 5 conductors (seed 01's driver/conductor included and completed):
profiles with joining date, experience, emergency contact, identity type + last 4, licence details (in each school one
licence expires within 30 days and one has expired), app logins (username such as `gwis.manjunath`, `sps.ramesh`,
`lva.srinivas`, `rsc.biju`; phone `+9198450002NN` / `+9198290002NN` / `+9198490003NN` / `+9194470004NN`; demo
password; drivers also PIN `1234`), documents (licence front/back, police verification, character certificate, first
aid, training or child safety, identity — some pending, some expiring or expired) and, for active buses without
assignment history, a primary driver and a conductor per bus plus a backup driver on R1. Idempotent.
