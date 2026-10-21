# Imports API (`imports` module)

Module `imports` · base path `/api/v1` · contract: ARCHITECTURE §3.3 (`import_batches`, `import_rows`), §4,
§6, §13, §17 "Imports", §24, §25 · FRD §20 · source `backend/src/modules/imports/`.

Bulk import of **buses** and **drivers** from spreadsheets: upload → validate → **stage** → review the
invalid-row report → **commit** with an explicit conflict policy (or cancel). Nothing is written to `buses` /
`drivers` before commit and existing records are never overwritten unless `conflictPolicy: "UPDATE"` is sent.

Roles: every admin role. Scope = the batch depot: a batch outside your scope → `404`; uploading into a depot
outside scope or filtering by one → `403 OUT_OF_SCOPE`. `:type` is `buses` or `drivers` (case-insensitive).
Audit: `import.upload`, `import.commit` (with counts) + one `bus|driver.importCreate|importUpdate` row per
entity, `import.cancel`.

## Columns

Headers match case-insensitively, ignoring spaces, punctuation and a trailing `*` (`Registration No*`,
`registration_no` and `registrationNo` are the same column); a few aliases are accepted (`Reg No`,
`Licence No`, `Mobile`, `DOB`, …). Missing required columns → `400` (nothing staged); unknown columns are
ignored and reported in `warnings`; a column given twice → `400`. Dates: `YYYY-MM-DD` (also `YYYY/MM/DD`),
Excel date cells or Excel serial numbers. Enum cells accept values or display labels
(`Air-conditioned` → `AC`, `o +ve` → `O+`). Values are normalised exactly like the manual endpoints
(registration `KA01F1234`, employee code upper-case, phone without spaces, licence without spaces).

| Buses | Required | Rule |
|---|---|---|
| Registration No | yes | 4–15 letters/digits after normalisation; **record key** |
| Fleet No | | ≤ 20; unique per depot (secondary key) |
| Make, Model | | text ≤ 60 |
| Capacity | | 1–200 |
| Bus Type / Fuel Type / Status | | `busTypes` / `fuelTypes` / `busStatuses` |
| Manufacture Year | | 1950–next year |
| Insurance Expiry, Fitness Expiry, Permit Expiry | | date |
| Odometer Km | | 0–10 000 000 |
| Notes | | text ≤ 1000 |

| Drivers | Required | Rule |
|---|---|---|
| Employee Code | yes | **record key** |
| Full Name | yes | ≤ 120 |
| Phone | yes | 7–15 digits, optional `+` |
| License No | yes | 5–25 of `A-Z 0-9 / -`; globally unique (secondary key) |
| License Expiry | yes | date |
| Email, Date of Birth, Date of Joining (> birth), Blood Group, Address, Emergency Contact, Status | | |

Driver imports never create logins — provision them with `POST /admin/drivers/:id/login`.

## GET /admin/imports/templates/:type?format=xlsx|csv

`xlsx` (default): sheet `Buses`/`Drivers` with the header row (required columns marked `*`), one example
row (delete it before uploading), drop-down **data-validation lists** for enum columns, whole-number and
date validation, and an `Instructions` sheet (column, required, format/allowed values, example).
`csv`: header + example row. Served as an attachment (`buses-import-template.xlsx`, …).

## POST /admin/imports/:type (multipart/form-data)

Fields: `file` (≤ 5 MB; **.xlsx or .csv detected by content** — `415 UNSUPPORTED_FILE` otherwise; CSV must be
UTF-8, delimiter `,` `;` or TAB detected from the header line, BOM allowed), `depotId` (defaults to the
caller's depot; required for higher admins). The first worksheet (other than `Instructions`) is read; row
numbers are spreadsheet rows (header = row 1); fully empty rows are skipped. More than `imports.maxRows`
(platform setting, default 5000) data rows → `400`; no data rows → `400`.

Row classification:

| Status | Meaning |
|---|---|
| `VALID` | passes validation, no matching record — will be created |
| `INVALID` | field errors, **or** the record key already exists in **another depot** (it can be neither created nor updated here; the depot code is named only when that depot is inside your scope), **or** the secondary key (fleet no / licence no) belongs to a different record |
| `DUPLICATE_IN_FILE` | same record key or secondary key as an earlier valid row (`"Duplicate of row 2"`) |
| `EXISTS` | a record with this key exists in the batch depot — skipped or updated at commit depending on the policy |

The original file is archived as an `IMPORT_SOURCE` document (`imports/{batchId}/{safeName}`) in the same
transaction as the batch and rows (object removed if the transaction fails). Response `201`: the batch
detail (below) plus

```json
{ "warnings": ["Unknown columns were ignored: Colour"],
  "problems": [ { "rowNo": 3, "status": "INVALID", "entityId": null,
                  "errors": [ { "field": "registrationNo", "column": "Registration No", "message": "Required" } ],
                  "raw": { "Registration No*": "", "Make": "=HYPERLINK(\"http://x\")" } },
                { "rowNo": 5, "status": "DUPLICATE_IN_FILE", "errors": [ { "field": "registrationNo", "column": "Registration No", "message": "Duplicate of row 2" } ], "raw": { "…": "…" } } ] }
```

`problems` = the first 50 non-VALID rows. Header errors:

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "The file headers do not match the template.",
  "details": [ { "path": "file.headers", "message": "Missing required column \"Registration No\"" } ], "requestId": "…" } }
```

## Batch DTO

List item:

```json
{ "id": "…", "type": "BUSES", "depotId": "…", "depotCode": "SHN", "depotName": "Shanthinagar", "regionId": "…",
  "fileName": "Fleet_Oct.xlsx", "status": "STAGED", "totalRows": 5, "validRows": 1, "invalidRows": 2,
  "duplicateRows": 2, "existingRows": 0, "conflictPolicy": null,
  "createdBy": "…", "createdByName": "Shanthinagar Depot Admin", "createdAt": "…Z",
  "committedBy": null, "committedByName": null, "committedAt": null }
```

Detail adds:

```json
{ "summary": { "sheetName": "Buses", "headers": ["Registration No*", "Fleet No", "…"],
               "mappedColumns": [ { "header": "Registration No*", "field": "registrationNo" } ],
               "unknownHeaders": [], "warnings": [], "sourceDocumentId": "…",
               "commit": { "created": 2, "updated": 0, "skipped": 0, "invalid": 0, "conflictPolicy": "SKIP", "committedAt": "…Z" } },
  "rowStatusCounts": { "VALID": 0, "INVALID": 1, "DUPLICATE_IN_FILE": 0, "EXISTS": 0, "COMMITTED": 2, "SKIPPED": 0, "UPDATED": 0 },
  "sourceDocument": { "id": "…", "fileName": "Fleet_Oct.xlsx", "sizeBytes": 6533, "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  "permissions": { "canCommit": false, "canCancel": false } }
```

Batch statuses: `STAGED` → `COMMITTED` | `CANCELLED`. `canCommit` requires a staged batch with at least one
VALID or EXISTS row.

## GET /admin/imports

`page`, `pageSize`, `sort` (`-createdAt` default, `status`, `type`, `fileName`, `depotName`, `committedAt`),
`type` and `status` lists, `regionId`/`depotId` (inside scope). One query.

## GET /admin/imports/:id · GET /admin/imports/:id/rows?status=

Detail as above. Rows: `page`, `pageSize`, `status` list; ordered by row number; items
`{ id, rowNo, status, raw, data, errors, entityId }` (`data` = normalised values, `entityId` = the matched or
created record).

## GET /admin/imports/:id/report?status=

CSV (`<file>-report.csv`) of the problem rows — default statuses `INVALID,DUPLICATE_IN_FILE` (any row
statuses may be requested). Columns: `Row, Status, Problems` (`"Column: message; …"`), then every original
header with the original cell text. Cells starting with `= + - @`, TAB or CR are prefixed with `'`
(formula-injection guard).

## GET /admin/imports/:id/source

`{ documentId, url, expiresAt, fileName, contentType, sizeBytes }` — 5-minute link to the archived original
(presigned S3, or the local download route).

## POST /admin/imports/:id/commit

Body `{ "conflictPolicy": "SKIP" | "UPDATE" }` (default `SKIP`). Honours `Idempotency-Key` (replay returns
the stored response with `Idempotent-Replayed: true`). One transaction:

1. lock the batch (`STAGED` only, else `409 INVALID_STATE_TRANSITION` with `details.currentStatus`);
2. **re-check existence** of every VALID/EXISTS row against the database under row locks — a record created
   meanwhile in the batch depot is treated as existing, one created/moved into another depot (or a secondary
   key taken meanwhile) turns the row `INVALID` ("… (detected at commit)");
3. insert new records with batched `unnest` statements (`ON CONFLICT DO NOTHING`: a conflicting concurrent
   insert makes the row `SKIPPED`) → rows `COMMITTED`;
4. existing records: `SKIP` → rows `SKIPPED`; `UPDATE` → only non-blank cells overwrite stored values
   (blank cells keep them; the record key is never changed) → rows `UPDATED`. A status change to
   `MAINTENANCE`/`INACTIVE` (buses) or `ON_LEAVE`/`SUSPENDED`/`INACTIVE` (drivers) on a record with upcoming
   trips is not applied — the row becomes `SKIPPED` with a message (same IN_USE rule as the PATCH endpoints);
5. final row statuses, batch `COMMITTED` (+ `summary.commit`), audit, outbox event `IMPORT_COMMITTED`.

After commit the `admin:buses` / `admin:drivers` list caches are invalidated and the notification worker is
nudged. Response `200`: batch detail plus `result: { created, updated, skipped, invalid }`.

Outbox payload (`notification_events.payload`, depot = batch depot) — the notifications worker delivers it
to `recipientUserIds` (the committer):

```json
{ "recipientUserIds": ["<committer user id>"], "batchId": "…", "type": "BUSES", "fileName": "Fleet_Oct.xlsx",
  "conflictPolicy": "SKIP", "created": 2, "updated": 0, "skipped": 0, "invalid": 0 }
```

## POST /admin/imports/:id/cancel

`STAGED` → `CANCELLED` (rows and the archived source are kept for audit) → `200` detail. Other statuses →
`409 INVALID_STATE_TRANSITION`.

## Internal service API

`src/modules/imports/columns.js` exports `COLUMNS`, `KEYS`, `mapHeaders(type, headers)`,
`parseCell(spec, value)`, `validateRow(...)` and `excelSerialToDate(n)`; `parser.js` exports
`parseSpreadsheet(file, { maxRows })` and `parseCsvText(text)`; `template.js` exports
`buildTemplate(type, format)`. No other module needs to call the imports service.
