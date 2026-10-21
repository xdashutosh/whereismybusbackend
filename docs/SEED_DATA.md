# Demo data

`cd backend && npm run seed` loads the demo world of contract §14. It is **idempotent** (a second run inserts
nothing and never overwrites saved values), refuses production without `--force`, and outside production
refuses any database that is not on localhost unless `--force` or `ALLOW_REMOTE_DEV_DB=true` (on such a
database every demo account must change its password at first sign-in). Seeds run in file order from
`backend/src/db/seeds/`:

| Seed | Adds |
|---|---|
| `00_platform` | Super Admin, every missing `platform_settings` default |
| `01_demo_tenants` | Greenwood + Sunrise (school, admin, one driver, one conductor, one student), the two-school parent |
| `10_platform` | Lakeview Academy + Riverside College, onboarded like `POST /platform/schools` (admin, plan, platform audit) |
| `20_school` | second admin per school, holidays 2026–27, announcements in every state, speed limit + alert recipients |
| `30_buses` | buses R1–R6 per school with state plates and 4 documents each (some expired / expiring) |
| `40_staff` | 6 drivers + 5 conductors per school with app logins, licences and documents; crews on buses R1–R5 |
| `50_routes` | 2 lines × morning/afternoon with 8 real-locality stops and expected times; bus ↔ route; Mon–Sat schedules |
| `60_people` | 32–48 students per school with both directions assigned, parents (siblings share a parent) |
| `70_trips` | per school the trips of the last 5 school days (20) with odometer evidence photos, anomalies and their alerts, a non-school trip; today's scheduled trips |
| `75_tracking` | location history of those trips (GPS tracks along the routes with stop dwell), stop events, trip summaries from the real trip-finalizer, a speeding stretch |
| `78_fleet_ops` | per school ~155 fuel logs over five months (city prices and stations; R3 CNG in kg, R5 electric in kWh; one deliberate odometer typo on R4), 74 maintenance logs over a year (11 service types, next due date / km) and 12 generated PDF bills / invoices (6 `fuel_bill` + 6 `maintenance_invoice`, one bill on the latest fill of each bus) |
| `80_alerts` | the real `document-expiry-scan` and `maintenance-due-scan` once per school (school-local day): document alerts for the expired / expiring bus and staff documents of seeds 30 and 40, and 6 `service_due` alerts for the maintenance logs of seed 78 (runs on the app pool under RLS; skipped with a warning when the app role is missing or bypasses RLS) |
| `85_notifications` | the live announcements delivered once into the parents' in-app inbox (parent notice: one entry per active linked parent), with the same per-segment delivery markers the announcement engine writes — no push, never re-sent by the sweep |

Fresh local database: `npm run db:reset -- --seed` (or `npm run db:reset && npm run db:setup-roles && npm run seed`).
Per school after seeding: 21 trips, ~155 fuel logs (154–159), 74 maintenance logs, 12 bill/invoice files, 26 alerts.

**Password of every demo account**: `SEED_DEFAULT_PASSWORD`, or `Wimb@12345` when it is not set. Accounts that
already exist keep their password. **Driver PIN**: `1234`. Parents sign in with an OTP only.

## Super Admin

| Account | Sign-in |
|---|---|
| `superadmin@example.com` (`PLATFORM_ADMIN_EMAIL`) | `POST /auth/platform/login` → the first sign-in returns a TOTP enrolment challenge (`POST /auth/platform/totp/setup` → scan the QR / otpauth URI, `POST /auth/platform/totp/verify` with a code); later sign-ins send `totpCode` |

## Schools and school admins

| School | Code | City, state | Type | Plan (max buses / students, valid until) | School admins (password above) |
|---|---|---|---|---|---|
| Greenwood International School | `GWIS-BLR` | Bengaluru, Karnataka | school | standard (50 / 2000, open) | `admin@greenwood.example` (Meera Iyer) · `transport@greenwood.example` (Arjun Nair) |
| Sunrise Public School | `SUNRISE-JPR` | Jaipur, Rajasthan | school | standard (50 / 2000, open) | `admin@sunrise.example` (Rajesh Sharma) · `transport@sunrise.example` (Neha Agarwal) |
| Lakeview Academy | `LAKEVIEW-HYD` | Hyderabad, Telangana | school | standard (12 / 900, valid 45 days from seeding) | `admin@lakeview.example` (Kavya Reddy) · `transport@lakeview.example` (Srinivas Reddy) |
| Riverside College | `RIVERSIDE-COK` | Kochi, Kerala | **college** | premium (20 / 2500, 1 year) | `admin@riverside.example` (Anil Menon) · `transport@riverside.example` (Anjali Thomas) |

All four schools are `active`. Sign in with `POST /auth/school/login` `{ "email", "password" }`.

## Drivers and conductors (driver app)

`POST /auth/staff/login` with `schoolCode` + `phone` **or** `username` + `password` **or** (drivers) `pin`, and a
`device` object. The first sign-in binds the session to that device.

| School code | Drivers (phone · username) — PIN `1234` | Conductors (phone · username) |
|---|---|---|
| `GWIS-BLR` | Ravi Kumar `+919845000101` · `gwis.driver` (R1) · Basavaraj Patil `+919845000214` · `gwis.basavaraj` (R2) · Manjunath Gowda `+919845000211` · `gwis.manjunath` (R3) · Naveen Shetty `+919845000215` · `gwis.naveen` (R4) · Prakash Hegde `+919845000213` · `gwis.prakash` (R5) · Shivakumar R `+919845000212` · `gwis.shivakumar` (R1 backup) | Lakshmi Devi `+919845000102` · `gwis.conductor` (R1) · Geetha Rao `+919845000224` · `gwis.geetha` (R2) · Kavitha S `+919845000221` · `gwis.kavitha` (R3) · Roopa M `+919845000223` · `gwis.roopa` (R4) · Shobha Naik `+919845000222` · `gwis.shobha` (R5) |
| `SUNRISE-JPR` | Mahendra Singh `+919829000201` · `sps.driver` (R1) · Bhanwar Lal `+919829000215` · `sps.bhanwar` (R2) · Om Prakash Jat `+919829000214` · `sps.omprakash` (R3) · Ramesh Meena `+919829000211` · `sps.ramesh` (R4) · Sanjay Sharma `+919829000212` · `sps.sanjay` (R5) · Vikram Shekhawat `+919829000213` · `sps.vikram` (R1 backup) | Pooja Rathore `+919829000202` · `sps.conductor` (R1) · Kamla Devi `+919829000222` · `sps.kamla` (R2) · Manju Gurjar `+919829000224` · `sps.manju` (R3) · Rekha Saini `+919829000223` · `sps.rekha` (R4) · Sunita Choudhary `+919829000221` · `sps.sunita` (R5) |
| `LAKEVIEW-HYD` | Anil Kumar Chary `+919849000316` · `lva.anil` (R1) · Mohammed Saleem `+919849000313` · `lva.saleem` (R2) · Narsimha Rao `+919849000314` · `lva.narsimha` (R3) · Raju Yadav `+919849000315` · `lva.raju` (R4) · Srinivas Reddy `+919849000311` · `lva.srinivas` (R5) · Venkatesh Goud `+919849000312` · `lva.venkatesh` (R1 backup) | Farzana Begum `+919849000325` · `lva.farzana` (R1) · Lakshmi Prasanna `+919849000323` · `lva.prasanna` (R2) · Padma Latha `+919849000321` · `lva.padma` (R3) · Saritha B `+919849000322` · `lva.saritha` (R4) · Swapna K `+919849000324` · `lva.swapna` (R5) |
| `RIVERSIDE-COK` | Anoop Kumar `+919447000413` · `rsc.anoop` (R1) · Biju Thomas `+919447000411` · `rsc.biju` (R2) · Joseph Mathew `+919447000416` · `rsc.joseph` (R3) · Rajesh Pillai `+919447000415` · `rsc.rajesh` (R4) · Shaji Varghese `+919447000414` · `rsc.shaji` (R5) · Suresh Nair `+919447000412` · `rsc.suresh` (R1 backup) | Ambili Raj `+919447000423` · `rsc.ambili` (R1) · Bindu Joseph `+919447000422` · `rsc.bindu` (R2) · Deepa Krishnan `+919447000424` · `rsc.deepa` (R3) · Mini George `+919447000425` · `rsc.mini` (R4) · Sreeja Menon `+919447000421` · `rsc.sreeja` (R5) |

Staff profiles carry joining date, experience, emergency contact, the identity proof **type + last 4
characters only**, licence number/class/expiry (drivers) and documents: licence front/back, police
verification, character certificate, first aid, training/child safety and an identity document (admin-only).
Per school 4 current staff documents are expired, 6 expire within 30 days and 8 are pending verification.
Document files are not seeded (they need stored objects): upload them through the admin panel.

## Buses

Per school R1–R6 (capacities 40, 40, 32, 26, 14, 45; R3 runs on CNG, R4 is a mini bus, R5 an electric van, R6 is in `maintenance`) with
state plates: Greenwood `KA01…`, Sunrise `RJ14…`, Lakeview `TS09…`, Riverside `KL07…` (e.g. Greenwood R1
`KA01AB1201`). Each bus has insurance, fitness, permit and pollution documents; per school R2 insurance
expires within 30 days, R4 pollution within 30 days, R3 fitness and R6 pollution are expired — the Buses list
shows the badges (`documentStatus=expired|expiring`). No images are seeded.

## Routes, stops and schedules

Per school two lines, each a **morning** route (pick-up towards the school) and an **afternoon** route (same
stops reversed), codes `R1`/`R2`, 8 stops each (`A1…A8` / `B1…B8`) with expected times, planned paths
through the stops and the school with `polylineSource: "straight"` (Google Routes is used automatically
once `GOOGLE_MAPS_SERVER_KEY` is set and the API is enabled: `POST /school/routes/:id/recompute-polyline`).
Bus R1 serves line R1 and bus R2 line R2; schedules run Monday–Saturday (`daysOfWeek [1…6]`).

| School | Line R1 | Line R2 | Morning (first stop – school) | Afternoon departure |
|---|---|---|---|---|
| `GWIS-BLR` | Bellandur – HSR Layout (Kaikondrahalli Lake → … → Silk Board Junction → St. John's Hospital) | Indiranagar – Koramangala (Indiranagar Metro Station → … → Koramangala 5th Block) | 07:00–07:35, schedule 06:50 | 14:30 |
| `SUNRISE-JPR` | Mansarovar – Durgapura (Mansarovar Metro Station → … → Gaurav Tower) | Raja Park – Jhalana (Raja Park → … → Malviya Nagar Sector 7) | 07:10–07:45, schedule 07:00 | 14:00 |
| `LAKEVIEW-HYD` | Hitech City – Banjara Hills (Hitech City Metro → … → Erramanzil Colony) | Secunderabad – Khairatabad (Paradise Circle → … → Khairatabad Circle) | 07:05–07:47, schedule 06:55 | 15:00 |
| `RIVERSIDE-COK` | Edappally – Kakkanad (Lulu Mall Edappally → … → Seaport–Airport Road Junction) | Tripunithura – Vyttila (Tripunithura Statue Junction → … → Rajagiri Valley) | 08:00–08:35, schedule 07:50 | 16:30 |

## Students and parents

| School | Students (admission numbers) | Parent phones |
|---|---|---|
| `GWIS-BLR` | 48: `GW-1001` (Aarav Mehta, 5 A) … `GW-1048` | `+91984502xxxx` (`+919845020001` …) |
| `SUNRISE-JPR` | 40: `SP-2001` (Isha Mehta, 3 B) … `SP-2040` | `+91982902xxxx` (`+919829020001` …) |
| `LAKEVIEW-HYD` | 36: `LV-3001` … `LV-3036` | `+91984902xxxx` (`+919849020001` …) |
| `RIVERSIDE-COK` | 32: `RC-4001` … `RC-4032` (college programmes) | `+91984702xxxx` (`+919847020001` …) |

Every student has a morning **and** an afternoon assignment (bus → route → stop) on lines R1/R2. Siblings
share a parent (e.g. Greenwood `+919845020009` Meena Iyengar → Shreya and Tejas Iyengar; Sunrise
`+919829020009` Meena Gupta → Aditya and Kritika Gupta).

**Two-school parent**: **Vikram Mehta `+919900000001`** — Aarav Mehta (Greenwood) and Isha Mehta (Sunrise); one
sign-in, children grouped by school, `X-School-Id` selects the school per request.

Parent sign-in: `POST /auth/parent/otp/request { "phone": "+919900000001" }` → with `SMS_PROVIDER=console` the
code is printed in the API log (`SMS (console provider) to +919900000001: <SMS_OTP_MESSAGE with the code>`); with
`SMS_PROVIDER=webpayservices` outside production, numbers not in `SMS_DEV_ALLOWED_NUMBERS` are printed the same
way. Then `POST /auth/parent/otp/verify { "phone", "otp" }`.

## Trips, odometer evidence, location history and alerts

Per school (`70_trips` + `75_tracking`, dates relative to the seeding day; schedules run Monday–Saturday, so a
Sunday seeding generates no trips for "today"):

| What | Where to see it |
|---|---|
| 20 school trips of the last 5 school days on buses R1/R2 (morning + afternoon): 19 completed or auto-closed with start/end odometer readings continuous per bus up to its `lastKnownOdometer`, 1 missed; plus 1 non-school trip | `GET /school/trips` (CSV export), driver `GET /driver/trips/history` (e.g. `gwis.driver`) |
| 39 odometer evidence photos (rendered JPEGs in the storage driver, camera source, SHA-256) | trip detail `evidence[].photoUrl` (presigned) |
| ~1 600–1 900 location points per school, every 15 s while moving, 30–90 s dwell at each stop | `GET /school/trips/:id/path?includePoints=true` (planned vs actual path) |
| `trip_stop_events` (arrival, departure, dwell) and `trips.summary` (simplified path, dwell, data quality, flags) from the real trip-finalizer | trip detail `stopEvents`, `summary` |
| Anomalies: R2 morning 3 days ago `odometer_gap`; R1 morning 2 days ago `odometer_gps_mismatch` (tracking stopped halfway); R1 afternoon 4 days ago `auto_closed` + `trip_auto_closed` (and the next R1 start flags `odometer_gap`); R2 afternoon yesterday `missed` + `trip_not_started`; R2 afternoon 2 days ago `speeding` (limit + 12 km/h); R1 yesterday evening non-school trip "Service at the authorised workshop" (`non_school_trip`) | trip list `flagged=true`, trip detail `flags`, admin bell (`school:{id}:alerts`) |

**Live demo** (driver app or the simulator): sign in as `gwis.driver` (R1) or `gwis.basavaraj` (R2) on a school
day, start today's trip with an odometer photo, then watch `GET /school/fleet/live` / the `school:{id}:fleet` room as
`admin@greenwood.example`. The trip simulator drives seeded drivers through the real API:
`cd backend && npx tsx scripts/simulate-trips.ts --base http://localhost:<port>/api/v1 --school GWIS-BLR --drivers gwis.basavaraj --force-start --direction morning --speed 60 --dwell 20`
(run the API with `SMS_PROVIDER=console RATE_LIMIT_ENABLED=false`). On a Sunday add day 7 to the school's schedules
first and generate today's trips (`generateDailyTrips`) — development databases only.

## Alert inbox (scan alerts)

Seed `80_alerts` raises what the 06:30 / 06:45 daily jobs would raise on the seeding day; with the trip anomalies
above and the service due alerts every school has **26 alerts**. Greenwood example (dates relative to the seeding day): `doc_expired`
(critical) for R3 fitness, R6 pollution, driver Prakash Hegde's licence and two police verifications;
`doc_expiring` (warning) for R2 insurance, R4 and R3 pollution, Manjunath Gowda's licence, first-aid and police
verification certificates; `service_due` — critical: R2 oil change and R3 CNG kit service overdue by date, R6 general
service overdue by km; warning: R1 general service and R5 battery health check due within 7 days, R2 tyre rotation due
within 500 km.

| Where | What |
|---|---|
| `GET /school/alerts` (`admin@greenwood.example`) | inbox with `meta.counts` per status, filters (`type=doc_expired,doc_expiring`), CSV |
| `PATCH /school/alerts/:id` | review (note) → escalate (e-mail is logged without SMTP; push goes only to signed-in admin devices) → close |
| socket `school:{id}:alerts` | `alert:new` (new alerts) and `alert:updated` (workflow changes, automatic resolution) |

Try a fresh alert: shorten a document's expiry (e.g. replace the R1 insurance with an expiry 5 days ahead through
`PUT /school/bus-documents/:docId`) and run the scan (`documentExpiryScan({ schoolId })` from
`backend/src/modules/alerts/jobs.ts`, or wait for 06:30 school time) → a `doc_expiring` alert appears.

## Fuel, maintenance, reports and dashboard

Seed `78_fleet_ops` (dates relative to the seeding day). Greenwood example: R1 26 fills, R2 23, R3 45 (CNG, kg), R4 21,
R5 21 (electric van, kWh), R6 22 (in `maintenance`, last fill a few weeks back); diesel prices and stations follow the city.

| What | Where to see it |
|---|---|
| Fuel logs with litres/cost totals, fill-to-fill km/l (`distanceKm`, `spanLitres`, `kmPerLitre`, `costPerKm`) | `GET /school/fuel-logs` (`meta.totals`, CSV), `GET /school/fuel-logs/mileage-trend?busId=<R1>` (every fill + monthly buckets), `GET /school/fuel-logs/mileage-summary` (one row per bus, CSV) |
| The R4 odometer typo: exactly two fills flagged (`odometerFlags` `below_previous` / `above_next`) | `GET /school/fuel-logs?flagged=true` |
| One PDF bill on the latest fill of each bus, one PDF invoice per bus | detail `bill` / `invoice` → `GET /files/:id/url` (school admins only) |
| Maintenance history with next due date / km and `dueStatus` (`overdue`, `due_soon`, `scheduled`, `completed`, `none`) | `GET /school/maintenance-logs` (`meta.totals.cost`, CSV) |
| Service due list = the 6 `service_due` alerts above (`reason` `date` / `km`) | `GET /school/maintenance-logs/due` (`status=scheduled` adds the rest), CSV |
| All seven reports have rows for the last 30 days (default range). Fuel and cost per km measure distance from the fill-to-fill odometer readings (`distanceSource: odometer`), so their km/l and ₹/km match the Fuel page mileage for the same bus, e.g. Greenwood R1 ≈ 5.9 km/l, ≈ ₹15/km; the seeded trips only cover about a week | `GET /school/reports/{bus-distance\|fuel\|maintenance\|cost-per-km\|service-due\|non-school-usage\|trip-summary}?format=json\|csv\|pdf` |
| Dashboard: 6 buses, 26 open alerts (service tile 6, 3 critical), document expiries, people counts, quick links | `GET /school/dashboard` |

Logging a service clears its alert at once: `POST /school/maintenance-logs` for bus R2 with `serviceType "Oil change"`
queues `maintenance-due-refresh`, which re-runs the due scan for the school and resolves the R2 oil-change alert.

## Parent inbox and notifications

Seed `85_notifications` puts the live parent notice ("Live bus tracking is now available") into every linked
parent's inbox — the two-school parent `+919900000001` has one entry per school. Trip notifications (trip
started, bus left school, approaching / arrived at the child's stop, delayed, not started) are created live by the
notifications engine while a trip runs (driver app or the simulator below) and appear in
`GET /parent/notifications`, as `notification:new` in the parent's `actor:{id}` room and in the school log
`GET /school/notifications`. The drivers notice and the scheduled PTM notice are not in the parent inbox (the PTM
one is delivered by the per-minute `announcement-sweep` once due).

## Calendar and announcements

Per school 6 holidays in 2026–27 (Greenwood: Kannada Rajyotsava 1 Nov, Diwali break 8–10 Nov, Annual Day
12 Dec *afternoon only*, Christmas, Republic Day, Holi) and 4 announcements covering every state: an expired
one, a pinned active one for parents, an active one for drivers and a scheduled one for everyone.

## Suggested demo flows

1. **Platform**: sign in as the Super Admin (enrol TOTP) → Schools list (4 tenants, Riverside is a college) →
   Lakeview detail (plan valid 45 days, usage vs limits) → Usage / Health.
2. **School setup** (`admin@greenwood.example`): profile, settings (speed limit, alert recipients),
   parent-visibility matrix with the staff parent preview (`GET /school/staff/:id/parent-preview`), holidays,
   announcements.
3. **Fleet**: Buses list → filter `documentStatus=expired` (R3, R6) → R1 detail (crew, documents, history) →
   replace the R3 fitness certificate (`PUT /school/bus-documents/:docId`) → assign a backup conductor.
4. **Staff**: Drivers list → licence expiry filter → reset Ravi Kumar's login (`POST /school/staff/:id/credentials`).
5. **Routes**: R1 morning on the map (8 stops, straight planned path) → reorder a stop → schedules (Mon–Sat).
6. **People**: Students list filtered by bus R1 → Aarav Mehta → assignment history → change the afternoon
   stop; Parents list → Vikram Mehta (linked in two schools) → reset access; CSV import dry run with the
   template (`GET /school/students/import/template`).
7. **Isolation check**: sign in as `admin@sunrise.example` and open a Greenwood bus id → `404`.
8. **Apps**: driver `GWIS-BLR` / `gwis.driver` / PIN `1234`; parent `+919900000001` (OTP from the API log).
   Parent flow: `GET /parent/children` (Aarav Mehta — Greenwood, bus R1, stop Kaikondrahalli Lake; Isha Mehta —
   Sunrise) → `GET /parent/children/:id/tracking` with `X-School-Id` → join the snapshot's `room`
   (`child:{studentId}:live`) on `/rt` → run the simulator for `gwis.driver` → `child:live` updates (≥ ~10 s apart
   while moving) and inbox entries for trip started, bus left school (afternoon), approaching and arrived.
9. **Trips & Audit** (`admin@greenwood.example`): Trips list → `flagged=true` → the R1 odometer↔GPS mismatch trip
   (start/end photos side by side, planned vs actual path, half the stops visited) → correct the odometer
   (`POST /school/trips/:id/correct-odometer`, reason required, original kept) → live fleet while the simulator
   runs → the trip ends and the finalizer fills the summary.
10. **Alerts** (`admin@greenwood.example`): alert inbox → filter `doc_expired` → review with a note → escalate →
   close; the bell room `school:{id}:alerts` receives `alert:updated`.
11. **Fleet costs** (`admin@greenwood.example`): Dashboard → Fuel (`flagged=true` shows the R4 typo; open a fill and
   correct the reading → the warning disappears) → R1 mileage trend → Maintenance due list (6 items) → log R2's oil
   change → the alert resolves → Reports: cost per km and service due as CSV and PDF (school logo header when a logo
   is uploaded). Isolation: `admin@sunrise.example` with a Greenwood fuel log id → `404`.

```bash
curl -s -X POST http://localhost:4000/api/v1/auth/staff/login -H 'Content-Type: application/json' \
  -d '{"schoolCode":"GWIS-BLR","username":"gwis.driver","pin":"1234","device":{"deviceId":"my-test-phone","platform":"android"}}'
curl -s -X POST http://localhost:4000/api/v1/auth/school/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@greenwood.example","password":"Wimb@12345"}'
```
