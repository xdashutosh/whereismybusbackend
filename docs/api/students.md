# Students & Parents API

Blueprint §4.6 (parents across schools), §6.2 (students, parents, links, assignments), §8.3 (Students, Parents,
Assignments), §13.3 (Students and Parents screens); contract §4, §5, §6, §9. Base `/api/v1`.
Source: `backend/src/modules/students/`; shared Zod schemas and DTO types:
`backend/shared/src/schemas/students.ts` + `studentsDto.ts` (`@wimb/shared`). Demo data: seed `60_people`.

* **School admins only** (`/school/*` area guard + route guard). Drivers, conductors and parents get `403`.
* Ids of another school answer `404 NOT_FOUND` on every endpoint (also ids inside bodies: bus/route/stop,
  parent, file); `school_id` in a body is ignored — the school always comes from the token.
* Every write is audited in its transaction: `student.create|update|delete`, `student.assignment_change`,
  `student.assignment_bulk`, `student.parent_link|parent_link_update|parent_unlink`, `student.import`,
  `parent.create|restore|update|delete|reset_access`, `parent.import`.
* Creates accept `Idempotency-Key`: `POST /school/students`, `POST /school/parents`, both imports.
* Students never sign in. **Parents** sign in to the parent app with their mobile number (OTP, see
  [auth.md](auth.md)); only numbers registered by a school can sign in.

| Method | Path | Purpose |
|---|---|---|
| GET | `/school/students` | List (filters, sort, pagination, `format=csv`) |
| POST | `/school/students` | Create |
| GET | `/school/students/:id` | Detail: student + parents + current/upcoming assignments |
| PATCH | `/school/students/:id` | Edit (partial; photo via `photoFileId`) |
| DELETE | `/school/students/:id` | Soft delete |
| POST | `/school/students/:id/parents` | Link a parent (existing, or create-or-reuse by phone) / unlink |
| DELETE | `/school/students/:id/parents/:parentId` | Unlink a parent |
| PUT | `/school/students/:id/assignment` | Bus → route → stop per direction (history kept) |
| GET | `/school/students/:id/assignment-history` | Every assignment row, newest first |
| POST | `/school/assignments/bulk` | Same assignment change for up to 500 students |
| GET | `/school/students/import/template` | CSV/XLSX template |
| POST | `/school/students/import` | Dry-run preview or commit of a student file |
| GET | `/school/parents` | List (filters, sort, pagination, `format=csv`) |
| POST | `/school/parents` | Register a parent (global identity created or reused) |
| GET | `/school/parents/:id` | Detail with children |
| PATCH | `/school/parents/:id` | Edit; phone correction; activate/deactivate |
| DELETE | `/school/parents/:id` | Remove from the school (links removed, sessions revoked) |
| POST | `/school/parents/:id/reset-access` | Sign the parent out everywhere, clear a sign-in lock (only if no other school uses the parent) |
| POST | `/school/parents/:id/sessions/revoke` | Sign the parent out of every device (same shared-account rule) |
| GET | `/school/parents/import/template` | CSV/XLSX template |
| POST | `/school/parents/import` | Dry-run preview or commit of a parent file |

## Parent identity (BP §4.6)

* `parent_accounts` is **global**, unique by E.164 mobile number: one parent with children in two schools
  signs in once and sees the children grouped by school. Registering a number creates the identity or
  **reuses** it (`ensure_parent_account()`); the response never reveals whether another school knows it.
* What a school knows about the parent (name, e-mail, relation, alternate phone, active flag) lives in that
  school's own `school_parents` row. **The API's parent `id` is that per-school id**; the global account id
  never leaves the server, so ids cannot be correlated across schools.
* Phone numbers are accepted in any common spelling (`98450 12345`, `+91-98450-12345`, `09845012345`) and
  stored as E.164 (`+919845012345`); invalid numbers → `400` on `phone`.

## Student object

```json
{
  "id": "01a1…", "admissionNo": "GW-1003", "fullName": "Ananya Gowda", "className": "8", "section": "A",
  "rollNo": "1", "isActive": true, "photoFileId": null, "photoThumbnailUrl": null, "parentCount": 2,
  "primaryParent": { "id": "01a1…", "fullName": "Kavitha Gowda", "phone": "+919845020003" },
  "assignments": {
    "morning": {
      "id": "01a1…", "direction": "morning", "busId": "01a1…", "busCode": "R1", "busName": "Route 1 Bus",
      "routeId": "01a1…", "routeCode": "R1", "routeName": "Koramangala – HSR (pick-up)",
      "stopId": "01a1…", "stopName": "Bellandur Gate", "stopSequence": 3, "expectedTime": "07:10",
      "validFrom": "2026-07-20", "validTo": null, "state": "current", "createdAt": "2026-10-18T01:00:00.000Z"
    },
    "afternoon": null
  },
  "createdAt": "…", "updatedAt": "…"
}
```
* `assignments.<direction>`: the assignment in force today (school-local date), otherwise the next upcoming
  one; `null` = unassigned. `validTo` is **exclusive** (`null` = open). `state`: `current` · `upcoming` · `ended`.
* `photoThumbnailUrl` (list) and `photoUrl` (detail) are presigned URLs valid ≤ 300 s; storage keys are never
  returned.

## `GET /school/students`

Query: `page`, `limit` (1–100, default 20), `sort` (default `className,section,fullName`; also `admissionNo`,
`rollNo`, `isActive`, `createdAt`, `updatedAt`, prefix `-` for descending), `q` (name, admission number,
exact roll number), `className`, `section` (case-insensitive), `isActive`, `hasParents`, and the assignment
filters: `busId`, `routeId`, `stopId` (current or upcoming assignment), `direction` (`morning`/`afternoon`,
narrows those and `unassigned`), `unassigned` (`true` → no current/upcoming assignment in `direction`, or in
at least one direction when `direction` is omitted; `false` → fully assigned). `format=csv` exports the
filtered list (admission no, name, class, section, roll, active, morning/afternoon bus/route/stop, primary
parent and phone, parent count; formula-guarded, ≤ 10 000 rows).

```
GET /api/v1/school/students?unassigned=true&direction=afternoon&sort=fullName&limit=50
```
`200` `{ "success": true, "data": [ <student> … ], "meta": { "page": 1, "limit": 50, "total": 3, "totalPages": 1 } }`

## `POST /school/students`

```json
{ "admissionNo": "GW-1100", "fullName": "Kabir Rao", "className": "2", "section": "B", "rollNo": "4",
  "notes": "Allergic to peanuts", "isActive": true }
```
Only `fullName` is required. `201` with the student. Errors: `409 DUPLICATE` when the admission number is
already used by a live student **of this school** (other schools may use the same numbers);
`403 FORBIDDEN` with `details { "reason": "SUBSCRIPTION_LIMIT", "resource": "students", "limit", "used", "adding" }`
when the plan's active-student limit is reached (inactive students do not count; re-activating one checks it too). `notes` are internal and never shown to parents.

## `GET /school/students/:id`

The student object plus:
```json
{
  "notes": null, "photoUrl": "https://…signed…",
  "parents": [
    { "id": "01a1…", "fullName": "Kavitha Gowda", "phone": "+919845020003", "email": null,
      "relation": "mother", "isPrimary": true, "isActive": true, "linkedAt": "…" }
  ],
  "effectiveAssignments": [ <assignment> … ]
}
```
`effectiveAssignments` lists every current and upcoming row (both directions); history:
`GET …/assignment-history`.

## `PATCH /school/students/:id`

Any subset of the create fields plus `photoFileId`. Photos: upload first with
`POST /files/upload` (`category=student_photo`, `entityId=<student id>`), then send the returned id;
`null` removes the photo. A file of another student/category → `400`, another school → `404`, an upload that
is not complete → `409`. Re-activating (`isActive: true`) checks the plan limit. Deactivating keeps the
assignments but hides the child from its parents (and disconnects their live sockets).

## `DELETE /school/students/:id`

Soft delete → `200 { "id": "…", "deleted": true }`. Current assignments end today, upcoming ones are cancelled
(history kept), parent links are removed, the admission number becomes free again.

## Parent links — `POST /school/students/:id/parents`

```json
{ "parentId": "01a1…", "relation": "aunt", "isPrimary": true }
{ "parent": { "phone": "98450 77011", "fullName": "Rohit Sharma", "relation": "father", "email": null } }
{ "action": "unlink", "parentId": "01a1…" }
```
* `parentId` links a parent of this school; `parent` registers the number in this school (create-or-reuse of
  the global identity; an existing parent of the school with that number is reused unchanged).
* `relation` is per child (defaults to the parent's relation). Each child has **exactly one primary parent**:
  the first linked parent becomes primary, `isPrimary: true` moves it, unlinking the primary promotes the
  earliest remaining parent.
* `200` with the child's parent list (as in the detail). `DELETE /school/students/:id/parents/:parentId` is the
  same as `action: "unlink"`. Unlinking a parent who is not linked → `404`. Unlinked parents' live sockets are
  disconnected so their room memberships are re-checked.

## Assignments — `PUT /school/students/:id/assignment`

```json
{
  "effectiveFrom": "2026-10-20",
  "morning": { "busId": "01a1…", "routeId": "01a1…", "stopId": "01a1…" },
  "afternoon": null
}
```
* Per direction: a target assigns, `null` ends the assignment, an omitted direction is unchanged (at least one
  is required). `effectiveFrom` = first school-local day of the change (default today; never in the past,
  at most a year ahead).
* Rules (in this order): bus, route and stop exist in this school (`404`, `details.field` = e.g.
  `morning.busId`); then `400 VALIDATION_ERROR` with field details when the bus is retired, the route runs in
  the other direction or is inactive, the stop does not belong to the route, or the bus does not serve the
  route (it needs an open bus ↔ route assignment or a live trip schedule on that route).
* History is never rewritten: rows still running on `effectiveFrom` are closed at that date (an upcoming row
  that has not started yet collapses to an empty window and stays in the history) and a new open row starts
  on it. An identical target already in force is left alone (`changed` does not list that direction).
  There is always at most one open row per student and direction (`one_open_assignment`), and windows never
  overlap (`student_assignments_no_overlap`).
* Parents only ever see the row in force today (RLS), so future-dated changes appear on their start day.

`200`:
```json
{
  "studentId": "01a1…", "effectiveFrom": "2026-10-20", "changed": ["morning", "afternoon"],
  "assignments": { "morning": <assignment>, "afternoon": null },
  "effectiveAssignments": [ <assignment> … ],
  "warnings": [ { "code": "BUS_OVER_CAPACITY", "busId": "01a1…", "busCode": "R1", "direction": "morning", "capacity": 40, "assigned": 41 } ]
}
```
`warnings` never block the change: they report buses whose active students assigned on `effectiveFrom` exceed
the bus capacity.

### `GET /school/students/:id/assignment-history`

Query: `page`, `limit`, `direction`. `200` list of assignment objects (`state` `ended` for history), newest first.

### `POST /school/assignments/bulk`

```json
{ "studentIds": ["01a1…", "01a1…"], "effectiveFrom": "2026-10-20", "afternoon": { "busId": "…", "routeId": "…", "stopId": "…" } }
```
The same rules and semantics for up to 500 students in **one transaction** (duplicates ignored). Unknown or
foreign student ids → `404` with `details.studentIds` and nothing changes. `200`:
```json
{ "effectiveFrom": "2026-10-20", "students": 2,
  "directions": [ { "direction": "afternoon", "assigned": 1, "ended": 0, "unchanged": 1 } ], "warnings": [] }
```

## Parent object

```json
{
  "id": "01a1…", "phone": "+919845020003", "fullName": "Kavitha Gowda", "email": null, "relation": "mother",
  "alternatePhone": null, "isActive": true, "hasSignedIn": true,
  "childCount": 1,
  "children": [ { "studentId": "01a1…", "fullName": "Ananya Gowda", "admissionNo": "GW-1003", "className": "8", "section": "A", "relation": "mother", "isPrimary": true } ],
  "createdAt": "…", "updatedAt": "…"
}
```
`hasSignedIn` is a flag only: the global identity's sign-in time, lockout counters and password hash are not
readable by schools (column privileges + `school_parent_sign_in_state()`, migration 015).

## `GET /school/parents`

Query: `page`, `limit`, `sort` (`fullName` default; `phone`, `childCount`, `isActive`, `createdAt`, `updatedAt`),
`q` (name, e-mail, or ≥ 3 digits of the mobile/alternate number in any spelling), `isActive`, `hasChildren`,
`studentId` (parents of one child), `format=csv` (name, mobile, e-mail, relation, alternate phone, active,
signed in, children).

## `POST /school/parents`

```json
{ "phone": "98450 77001", "fullName": "Meera Iyer", "email": "meera@example.com", "relation": "mother", "alternatePhone": null }
```
`201` with the parent. The number already registered **in this school** → `409 DUPLICATE`
(`details.parentId`). A parent removed earlier from this school is restored with the new details
(`parent.restore`; its old links are not brought back).

## `PATCH /school/parents/:id`

Any subset of `phone`, `fullName`, `email`, `relation`, `alternatePhone`, `isActive`.
* `phone` corrects the global identity, allowed only while the parent belongs to **this school alone**
  (`school_update_parent_phone()`): shared with another school → `409 INVALID_STATE`
  (`details.reason = "SHARED_PARENT"` — register the new number as a separate parent instead); a number used
  by another parent → `409 DUPLICATE`.
* `isActive: false` blocks the parent in this school at once (every parent request re-checks its active links)
  and **revokes all its sessions and disconnects its sockets** (contract §6); a parent shared with another
  school signs in again and keeps access there. A phone change also ends the sessions.

## `DELETE /school/parents/:id`

Removes the parent from this school: soft delete, its links to this school's students are removed, its sessions
are revoked and sockets disconnected → `200 { "id": "…", "deleted": true }`. The global identity and other
schools are untouched.

## `POST /school/parents/:id/reset-access`

```json
{ "reason": "Lost phone" }
```
Signs the parent out on every device (all sessions revoked, sockets disconnected) and clears a failed-password
lock (`school_clear_parent_lockout()`, audited in the same transaction as `parent.reset_access`); the parent
signs in again with an OTP. The global identity is not otherwise changed: a password fallback
is only ever set by the parent (see [auth.md](auth.md)). `200`:
```json
{ "parentId": "01a1…", "revokedSessions": 2, "otpReady": true, "blockers": [], "unlocked": true, "sharedAccount": false }
```
**Shared parents (migration 854).** Sessions and the sign-in lock belong to the parent's global identity, and any
school can register any phone number. So they are reset **only when no other school uses this parent**. When another
school does, nothing global changes: `revokedSessions` is `0`, `unlocked` is `false`, and `sharedAccount` is `true`
— but only if the parent has also used **this** school (otherwise the answer would reveal another school's parent,
so it reads exactly like a number nobody has used). The parent detail's `hasSignedIn` is per school
(`school_parents.first_signed_in_at`), not global.
`otpReady` tells whether the number can request a sign-in code now; `blockers` explains why not:
`PARENT_INACTIVE` (deactivated in this school), `ACCOUNT_INACTIVE` (global account disabled), `NO_ACTIVE_CHILD`
(no active child linked here). Parent sessions are school-less, so after the school's own checks the revocation
runs in the parent account's own context (`auth.ownerContext`).

## `POST /school/parents/:id/sessions/revoke`

No body. Signs the parent out on every device without touching links, lockout or OTP access (audited as
`parent.sessions_revoke`, phone masked). → `200 { "parentId": "…", "revokedSessions": 2, "sharedAccount": false }`.
If another school also uses the parent, its global sessions are kept (one school cannot sign a parent out of another
school): `revokedSessions: 0`, `sharedAccount: true`, and the parent's sockets are re-authorised against
their current links.

## Imports (students and parents)

1. Download a template: `GET /school/students/import/template?format=csv|xlsx` (or `/school/parents/…`).
2. Upload the filled file (CSV UTF-8 or XLSX, ≤ 5 MB, ≤ 5 000 rows) with `POST /files/upload`, `category=import`.
3. `POST /school/students/import` (or `/school/parents/import`) with
   ```json
   { "fileId": "01a1…", "dryRun": true, "onExisting": "update" }
   ```
   `dryRun` defaults to `true` (preview, nothing written). `onExisting`: rows matching an existing record (student
   by admission number, parent by phone) are updated (`update`, default — non-empty cells replace values, empty
   cells keep them) or left alone (`skip`).
4. Commit with `dryRun: false`: the file is validated again inside **one transaction**; any row error →
   `400 VALIDATION_ERROR` whose `details` is the same report, and nothing is written. Otherwise every change is
   applied with batched statements and audited once (`student.import` / `parent.import`, counts + file id).

Report (`200` for previews and commits):
```json
{
  "dryRun": true, "committed": false, "fileId": "01a1…", "format": "csv",
  "columns": ["admission_no", "full_name", "class_name", "parent1_name", "parent1_phone"],
  "ignoredColumns": ["Unknown Column"],
  "summary": { "totalRows": 7, "validRows": 3, "errorRows": 4, "create": 2, "update": 1, "unchanged": 0, "skip": 0,
               "parentsCreated": 1, "parentsUpdated": 0, "links": 3 },
  "errors": [ { "row": 3, "field": "admission_no", "message": "Duplicate of row 2" } ],
  "rows": [ { "row": 2, "action": "update", "key": "ADM-001", "name": "Aarav Sharma", "links": [] } ]
}
```
`row` is the spreadsheet row (header = row 1); `rows` holds the first 200 rows, `errors` every error (≤ 1 000).

**Student file** — one row per student; header names are case/space-insensitive with aliases
(`Admission No`, `Name`, `Class`, `Parent 1 Phone`, …):

| Column | Rules |
|---|---|
| `admission_no` | required, ≤ 40, unique in the file; matches existing students of this school |
| `full_name` | required, ≤ 200 |
| `class_name`, `section`, `roll_no`, `notes` | optional (≤ 40 / 20 / 20 / 2 000) |
| `parent1_name`, `parent1_phone`, `parent1_email`, `parent1_relation` (and `parent2_*`) | optional; when any is filled the phone is required and valid; the name is required for a parent new to the school (it may be given on another row — siblings share parents) |

Parents are reused within the school (by phone), restored if removed, or registered (global identity reused or
created). Links are only added; the first parent becomes the child's primary when it has none.

**Parent file** — one row per parent: `phone` (required, unique in the file), `full_name` (required for a parent
new to the school), `email`, `relation`, `alternate_phone`, `student_admission_nos` (`;`-separated children to
link, ≤ 10; unknown numbers are row errors).

Template / file errors: a file of another school → `404`; a file that is not `category=import` or not uploaded →
`400`; unreadable XLSX or non-UTF-8 CSV → `415`; missing key columns → a row-1 error; committing more new active
students than the plan allows → `403 FORBIDDEN` (`details.reason = "SUBSCRIPTION_LIMIT"`).

## Files

`student_photo` files: school admins read every photo of the school; a parent reads only the photo currently set
on a live, active child linked to them (the school's parent-visibility matrix has no student section, so a parent
always sees their own child's photo and never another child's); drivers and conductors never.
