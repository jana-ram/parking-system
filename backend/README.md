# Smart Parking OS — Backend

Node.js + Express + Mongoose, matching `nammaraidu-web/backend`'s conventions.
See `../docs/ARCHITECTURE.md` for the full design (§B repo structure, §E schema, §F–I state machines).

## Phase 1-4 status (current)

**Phase 1** — all ~30 Mongoose models (§E), the `requireOrgScope` tenant-isolation plugin, the domain layer (pricing engine + session/token/shift state machines), and proof multi-document transactions work against a real replica set.

**Phase 2** — RBAC + Org/Location/Staff/Device, all covered by `npm test`:

- `POST /platform/auth/login`, `POST/GET /platform/organizations`, `PATCH /platform/organizations/:id/status` — platform admin onboards a tenant by creating its Organization **and** first StaffUser(ORG_ADMIN) together, atomically (there's no self-serve staff signup — see `platformOrg.controller.js`'s header comment for why).
- `POST /auth/staff/login` (org-scoped by `orgCode`), `GET/PATCH /orgs/me`, `GET/POST/PATCH /locations`, `GET/POST/PATCH /staff`, `POST /devices/register`, `GET /devices`, `POST /devices/:id/deactivate`.
- `deviceCheck.middleware.js` — the server half of §N's HMAC request signing, verified end-to-end against the exact client algorithm in `SmartParkingMobile/src/api/index.ts` (`src/__tests__/phase2.rbacAndDevice.test.js`), including tamper detection, replay-window rejection, and deactivated-device rejection.
- Full RBAC matrix (§O) covered by automated route tests: every Staff/Manager/Org Admin combination against every new route, plus cross-organization isolation (a device/JWT from org B cannot read or write org A's data, and gets 404 rather than a leak on direct-ID lookups).

`requireOrgScope` caught a real bug during this phase's own build (a device-registration duplicate check that legitimately needed to look across all orgs but had no explicit opt-out) — see the fix in `device.controller.js` for what that looked like in practice.

**Phase 3** — Vehicle/Token/Session/Pricing/Payment + the entry→exit flow, online-only (offline/sync is Phase 5), covered by `npm test`:

- `GET/POST /vehicle-types`, `GET/POST /pricing-rules` (+ `/versions`, `/preview`), `GET /tokens` (+ `/summary`, `POST /batches`, `POST /:id/reinstate`), `POST /shifts/start` (a deliberately minimal slice — see `shift.controller.js`'s header for why close/tally/handover wait for Phase 4).
- `POST /sessions/entry`, `POST /sessions/:id/exit/request`, `POST /sessions/:id/payment`, `GET /sessions/active`, `GET /sessions/search` — the actual parking-lot core loop, orchestrated in `services/session.service.js`, pricing-mode-aware (§F) for all four modes.
- `locationCheck.middleware.js` — the first version of §M's layered check (GPS-in-geofence + unconditional mock-location hard block + device-location binding); `shiftCheck.middleware.js` — §14's "no sensitive op without an active shift."
- `src/__tests__/phase3.entryExitFlow.test.js` — full PAY_ON_EXIT and PAY_ON_ENTRY happy paths end-to-end through real HTTP + a real transactional DB, plus the illegal-transition/anomaly rejections: double-exit, token-already-active, vehicle-already-active, no-active-shift, wrong-location, mock-location, wrong-location-token.

Three real bugs this phase's own tests caught before they'd have surfaced in production, all fixed in place (see the inline comments at each fix for the full story):
1. **`getActiveVersion`/`resolveActiveRule` had no `organizationId` filter** — `requireOrgScope` correctly blocked it (`services/pricingRule.service.js`).
2. **The device-signature path being signed included the query string** (`req.originalUrl`), but the mobile client can only sign the bare path at axios-interceptor time (query params are serialized onto the URL *after* interceptors run) — every signed GET-with-query-params request would have failed verification in production. Fixed by signing/verifying the path without its query string (`deviceCheck.middleware.js`).
3. **MongoDB's `partialFilterExpression` rejects `$nin`/`$not`/`$or`/`$ne`** — the "no double-active-session" indexes from the original architecture doc's §E sketch were invalid from the moment they were written; Mongoose's background `autoIndex` just hadn't been forced to build them eagerly yet, which is *also* now fixed (`config/db.js` blocks server startup on `Model.init()` for every model, precisely so this class of bug fails loudly at boot instead of silently at 2am). Fixed with the standard workaround — a plain boolean flipped by a `pre('save')` hook (`models/ParkingSession.js`).

**Phase 4** — shift close/tally, force-close, and handover, covered by `npm test`:

- `POST /shifts/:id/close` (computes the cash/session tally in `services/shift.service.js`, §15 — cash-only variance, since UPI/card don't need physical counting), `GET /shifts/:id/tally`, `POST /shifts/:id/tally/approve` (Manager+, required once `|variance| > ₹100`), `POST /shifts/:id/force-close` (Manager+, always creates an `Incident` — §14/§H), `POST /shifts/:id/handover/initiate`, `POST /handovers/:id/accept` (only the incoming staff member).
- **Active-vehicle carry-forward needed no new code at all** — it's a direct consequence of §17's design: a `ParkingSession` simply keeps existing across a handover, with `entryShiftInstanceId` staying historical while `exitShiftInstanceId` is whichever shift actually processes the exit. `initiateHandover`'s active-vehicle-count snapshot (via the `isActiveSession` flag from Phase 3's index fix) is what proves this in the test rather than anything bespoke.
- `src/__tests__/phase4.shiftAndHandover.test.js` — a full two-shift handover (morning parks a vehicle, closes, hands over to evening, evening accepts and later exits the *same* session), a cash-mismatch-past-threshold case requiring Manager approval (and rejecting Staff self-approval), and the force-close/abandoned path with its Incident.

**Phase 5** — the sync engine (backend half), covered by `npm test`:

- `POST /sync/push` (batched, one DB transaction per event — a later event failing never rolls back an earlier one that already succeeded) and `GET /sync/pull` (token registry for the device's location).
- `src/domain/retryPolicy.js` — the §25 bounded backoff schedule (5s/15s/30s/1min/5min, then `BLOCKED`) as a pure, tested function; `src/domain/syncConflictPolicy.js` — the §K decision table distilled into one classifier: every business-rule error the app's own services already throw (`TOKEN_ALREADY_ACTIVE`, `SESSION_ALREADY_TERMINAL`, ...) is a **permanent** conflict that goes straight to `CONFLICT` + an `Incident` for a human, never into the retry loop; anything else is treated as transient and retried per the backoff schedule until it's `BLOCKED` (also raising an `Incident`, on exhaustion).
- `src/__tests__/phase5.sync.test.js` — idempotent replay through the real endpoint, a genuine two-push conflict (second loses, `CONFLICT` + `Incident`), the retry schedule actually being enforced end-to-end (not just unit-tested — `retryCount` and `nextAttemptAt` progress correctly across repeated pushes of the same failing event, then `BLOCKED` on exhaustion, then further pushes short-circuit without even re-invoking the handler), and pull.

**Scope limits, stated plainly rather than glossed over:**
1. Only `ParkingSession:CREATE` (vehicle entry) is wired through the sync dispatch table — see `sync.service.js`'s header for why every other entity type is the identical pattern, not a harder problem, and was left for a later pass to keep this phase reviewable.
2. **This is the backend half only.** The mobile app's SQLite outbox and the on-device Detox verification the architecture doc's Phase 5 exit criterion literally calls for ("all 15 offline/sync cases pass on-device... including kill-process-mid-write") are not achievable in this environment — see `SmartParkingMobile/README.md`'s Phase 5 section for exactly what exists there (the outbox logic, fully unit-tested against an in-memory store) versus what's still owed (a real SQLite binding, and an actual device pass).

One real bug this phase's own test caught: the sync dispatch handler wasn't threading the sync envelope's `clientTransactionId` through to the underlying entity payload, so every real entry-via-sync failed Mongoose's `required` validation on `ParkingSession.clientTransactionId`. Fixed in `sync.service.js` by injecting it at the dispatch call site — a fix that automatically covers every future entity handler too, not just this one.

**Phase 6** — location/device security hardening, audit read, anomaly detection, incident visibility, covered by `npm test`:

- `locationCheck.middleware.js`: **polygon geofence** (point-in-polygon, for irregular lots — `utils/helpers.js`'s `isPointInPolygon`) alongside the existing radius check; **Play Integrity hard block** (a failing attestation verdict is rejected exactly like `mockDetected`, unconditionally — §1 item 4); every **failure** now writes its own `AuditLog` row, since a rejected request never reaches the controller that would otherwise record one, and the anomaly engine has nothing to count without it.
- `GET /audit-logs` (Manager+, filterable by entity/actor/action/date) and `GET /incidents` (Manager+) — read-only visibility onto data every prior phase was already writing.
- `POST /sessions/:id/cancel` — genuinely new functionality, not just plumbing: Phase 3 never built a cancel endpoint, and implementing one surfaced a real state-machine gap (below).
- The anomaly engine (`domain/anomalyScoring.js` + `services/anomaly.service.js`) — explainable risk scoring in the exact shape §20 asks for (`riskScore`, `riskLevel`, a `reasons` list a Manager can actually read), computed automatically at every shift close. Implemented rules: excessive cancellations, cash mismatch, exit-without-payment, abnormally fast token reuse cycles, repeated location violations, backdated transactions. `anomaly.service.js`'s header explains exactly which §R rules are deliberately NOT implemented and why (discounts/corrections have no underlying feature yet; "device sharing" would misfire against this product's own legitimate one-device-many-shifts design from Phase 2).
- `src/__tests__/phase6.securityAuditAnomaly.test.js` — polygon pass/fail, the Play Integrity block, location-failure audit logging, audit-log RBAC, cancel + its RBAC, a clean shift producing zero anomalies, and a deliberately "dirty" shift (6 cancellations + an ₹110 cash mismatch + 3 location violations) producing a real HIGH/CRITICAL, multi-reason anomaly from actual accumulated data — plus incident visibility.

Two real things this phase's own build caught, fixed in place:
1. **A dead state-machine transition.** `PAY_ON_ENTRY`/`FIXED_DURATION` only allowed cancellation from `CREATED` — but `enterVehicle()` always advances a session past `CREATED` synchronously, in the same transaction as creation, so no session is ever observably sitting there for a later cancel request to act on. Building the cancel endpoint is what surfaced this; fixed by allowing cancellation from `PAYMENT_PENDING` instead (the realistic point: "customer decides not to park, before paying"), in both the backend and its mobile mirror.
2. **An inconsistent RBAC/shift-check pairing.** `POST /sessions/:id/cancel` initially required the *cancelling* Manager to have their own active shift, unlike the structurally identical `force-close` (Phase 4), which doesn't. Removed `shiftCheck` from the cancel route — a Manager-issued override is an administrative action, not a floor operation, and the role gate + mandatory reason + audit trail already cover it.

**Phase 7** — three small, real API additions the mobile app's actual screens surfaced as missing (not pre-planned — discovered by building the UI against the existing API and hitting real gaps), covered by `npm test`:

- `GET /shifts/current` — lets the app recover "do I already have an open shift" after a restart, without which it would either wrongly show the Start Shift screen or have to persist a shift ID locally in a way that can't survive a reinstall.
- `GET /sessions/by-token/:tokenCode` — the Scan & Exit screen only ever has a token *code* in hand; the exit endpoint needs a session *ID*. This bridges the two (looks up the token, follows its `currentSessionId`), with `vehicleId` populated (org-scoped via an explicit `match`, since `populate()`'s underlying query has no `organizationId` filter by default — the same class of gap `requireOrgScope` caught twice before).
- Full test coverage added directly to the existing Phase 3/4 integration test files rather than a new one, since these are small, targeted extensions of endpoints those files already exercise.

**Phase 8** — cross-org platform read endpoints for the Product Owner web dashboard (`../owner-web`), covered by `npm test` (`src/__tests__/phase8.platformOps.test.js`):

- `GET/POST /platform/countries`, `GET /platform/locations`, `GET /platform/devices` (+ `POST /platform/devices/:id/deactivate`), `GET /platform/anomalies`, `GET /platform/incidents`, `GET /platform/audit`, `GET /platform/analytics/overview`.
- Every one of these deliberately reads across ALL tenants — the `/platform/*` router is the one sanctioned cross-tenant reader (§1.7), so each uses `.setOptions({skipOrgScope: true})` explicitly wherever the target model is `requireOrgScope`-guarded, plus `.populate('organizationId', 'name code')` for display (no `match` needed there specifically, since `Organization` itself carries no `organizationId` field and was never guarded — see `platformOrg.controller.js`'s original header comment).
- The test proves the actual guarantee that matters: one platform-admin call returns data from *two different organizations* in a single response — something no bug reintroducing tenant scoping into these routes could produce, and something a same-shaped tenant-scoped test could never demonstrate.
- Real gap, stated plainly: platform-level reads are not yet self-audited (`platformAudit.controller.js`'s header explains why — `AuditLog.organizationId` is required, so a platform-only audit event has nowhere to attach without a schema change or a separate collection).

Not yet built (Phase 9+ per §Z's milestone table): corrections/refunds, reports, subscriptions/billing, full platform analytics beyond the overview tiles, and the testing/performance/security/deployment work itself. Deliberately not stubbed with empty 200-returning handlers — an unbuilt route 404s instead of lying about being ready.

## Local setup

MongoDB **must** be a replica set (§1.1) — a standalone `mongod` will fail on the first transactional write (entry/exit). One-time local setup:

```bash
mongod --replSet rs0 --dbpath ./.mongo-data --port 27018
mongosh --port 27018 --eval "rs.initiate()"
```

Then:

```bash
cp .env.example .env    # fill in JWT_SECRET, DEVICE_SECRET_ENC_KEY, etc.
npm install
npm test                # domain + integration tests, no real Mongo needed (mongodb-memory-server)
npm run dev              # requires the replica set above running
```

**Phase 9** — full test suite / load testing / security review / deployment automation:

- **Test suite**: all 186 tests / 16 suites still pass (`npm test`) after every change below — re-verified, not assumed.
- **Load test** (`npm run loadtest`, `loadtest/outageRecoveryBurst.js`) — the §Z exit criterion ("sustains a simulated outage-recovery burst"): 150 simulated devices, each with 5 queued offline entry events, reconnect and push through `/sync/push` simultaneously alongside 100 concurrent reads. Result: all 750 events synced exactly once, zero errors, zero lost writes, reads unaffected. The script's own header explains why its latency numbers are informational only, not a capacity claim — it runs against a single embedded `mongod` (via `mongodb-memory-server`) sharing one dev machine's CPU/disk with the load generator, not real deployment hardware. What it *does* gate on (and what actually matters for this milestone) is correctness under concurrent load, not an unbenchmarked absolute latency number. Wired into CI (`.github/workflows/backend-ci.yml`) so this runs on every push to `main`, not just once by hand.
- **Security review** — findings and fixes from a manual pass grounded in §X's threat model (no ZAP/DAST tool available in this environment; substituted with dependency audits + targeted code review):
  - *Fixed*: 4 unused backend dependencies removed (`@aws-sdk/client-s3`, `node-cron`, `socket.io`, `uuid` — confirmed unused via grep before removal), resolving the only `npm audit` finding (0 vulnerabilities remaining).
  - *Fixed*: JWT algorithm pinning — `{ algorithms: ['HS256'] }` / `{ algorithm: 'HS256' }` added to every `jwt.verify`/`jwt.sign` call (`auth.middleware.js`, `platformAuth.middleware.js`, `StaffUser.js`, `PlatformAdmin.js`). Defense-in-depth against algorithm-confusion attacks; `jsonwebtoken` 9.x already defaults safely for a symmetric secret, but this removes any dependence on that default staying safe across a future upgrade.
  - *Fixed*: default platform-admin credentials — `seedPlatformAdmin()` in `server.js` previously fell back to a hardcoded `owner@smartparkingos.com` / `ChangeMe@123` if the env vars were unset, a classic default-credentials hole. It now refuses to seed at all when `NODE_ENV=production` and either `PLATFORM_ADMIN_EMAIL` or `PLATFORM_ADMIN_PASSWORD` is missing, throwing instead of silently creating a guessable-password admin account. The dev/test convenience default is unchanged (matches the same production-vs-dev gating pattern `config/db.js` already uses for the replica-set check).
  - *Known, deliberately not fixed here*: no refresh-token rotation. `StaffUser`/`PlatformAdmin` issue a single long-lived JWT (`JWT_EXPIRE`, default 12h) with no refresh endpoint — simpler than the original architecture doc's §N sketch, and a real simplification worth surfacing explicitly rather than letting it go undocumented. Revoking a compromised token before its natural expiry currently means rotating the signing secret (which invalidates *every* session on that realm), not a targeted single-session revoke.
  - *Known, deliberately not fixed here*: unvalidated query-param filters on read-only list endpoints (e.g. `/audit-logs`, `/platform/*` GETs) — low severity in practice, since `express-mongo-sanitize` strips Mongo operator injection and `requireOrgScope` bounds every tenant query regardless of what a filter param contains, but there's no allowlist/schema validation on the filter values themselves.
  - *Known, out of this repo's control*: `owner-web` stores its JWT in `localStorage` rather than an httpOnly cookie (XSS-exposed) — see `owner-web/README.md`'s security notes for the tradeoff.
- **CI**: `.github/workflows/backend-ci.yml` — `npm ci`, `npm audit --omit=dev --audit-level=high`, `npm test`, then the load test, on every push/PR touching `backend/`.
- **Deployment automation** (`../infra/`): PM2 `ecosystem.config.js`, nginx templates for the API and dashboard, `deploy.sh`, and a fresh-Ubuntu-VPS `provision.sh` (Node/MongoDB-replica-set/PM2/nginx/ufw/certbot setup, random secret generation, first deploy). Scaffolded but **not exercised against a real VPS in this environment** — no server to provision here — so treat it as a reviewed starting point, not a battle-tested script.

## Testing notes

`npm test` needs no external services — `mongodb-memory-server` spins up an ephemeral, real, single-node **replica set** per test file specifically so the transaction tests exercise the same code path production will use, not a standalone-mongod shortcut that would hide a real bug.
