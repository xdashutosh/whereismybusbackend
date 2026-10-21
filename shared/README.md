# @wimb/shared

TypeScript enums, Zod DTO schemas and API types shared by the backend (API) and the admin web app
(contract §1). Built with `tsc` to `dist/` (ESM + declarations).

## Vendored copy: keep both repos identical

This folder is **vendored**: the same package lives at `shared/` in both the backend repo and the
admin repo, so each repo builds on its own from a fresh clone. Each consumer depends on it
via `"@wimb/shared": "file:./shared"`, so `npm ci` installs this folder's dev dependencies with the
consumer's own; its `postinstall` (`node scripts/build-shared.mjs`) builds `dist/`, and `prebuild` / `pretest` / `pretypecheck`
rebuild it. Nothing here is published to npm.

**Change it in one repo, then copy the folder to the other** (same commit message in both). Check that
the two copies match with the consumer's sync script, pointing it at a sibling checkout of the other repo:

```bash
node scripts/check-shared-sync.mjs ../admin     # run in the backend repo (admin checked out next to it)
node scripts/check-shared-sync.mjs ../backend   # run in the admin repo (backend checked out next to it)
```

It compares every file except `node_modules/` and `dist/` and exits 1 on any difference.

* `src/enums.ts` — roles, owner types, school/bus/trip/alert statuses, directions, trip types, alert
  types and severities, device event types (incl. `location_permission_*`, `clock_drift`), parent trip phases,
  document types, notification events/channels, staff types, file categories,
  socket namespace/events, error codes + HTTP statuses, header names.
* `src/api.ts` — success/list/error envelope types, `ListMeta`, `API_PREFIX`, `LivePosition`.
* `src/schemas/` — Zod schemas (`common`, `device`, `location`); add `<module>.ts` and re-export it
  from `schemas/index.ts`. `common.ts` also has `withPeriod()` + `periodShape` (accepts `period=<from>..<to>`
  next to `from` / `to` on list and report queries); `location.ts` has the device clock limits
  `CLOCK_DRIFT_TOLERANCE_MS` (60 s) and `CLOCK_DRIFT_MAX_CORRECTION_MS` (24 h) shared with the driver app.

`zod` is a peer dependency (`^3.25`).

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | `tsc -p tsconfig.json` → `dist/` (tests excluded) |
| `npm run typecheck` | source (`tsconfig.json`) and tests + `vitest.config.ts` (`tsconfig.test.json`), no emit |
| `npm test` | vitest unit tests (`npm run test:watch` to watch) |

## Tests

Unit tests sit next to the code as `src/**/*.test.ts` (vitest, node environment, no database or network)
and are left out of the build. They cover the `common.ts` primitives (UUID/date/time/e-mail/time-zone/semver,
query-string coercion, `withPeriod()`), the enum tuples (unique values, `ERROR_STATUS` for every
`ERROR_CODES` entry, derived tuples), the package entry re-exporting every subpath export without clashes,
and the cross-field rules and helpers of the module schemas (`location`, `buses`, `trips`, `staff`,
`school`, `reports`, `fuel`, `maintenance`, `alerts`, `routes`, `students`, `platform`, `privacy`, `parent`).
A new refinement, transform or helper gets a test in the matching `<module>.test.ts`. The backend and
admin suites still exercise the schemas through their routes and forms. CI runs typecheck, tests and
build in the `shared` job of the backend repo's `.github/workflows/ci.yml`; the admin repo's CI runs the same
tests (`npm --prefix shared test`) after its install builds the package.
