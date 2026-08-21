# Smart Parking OS — Product Owner Web Dashboard

React + Vite + Tailwind, matching `nammaraidu-web/admin`'s conventions (react-router-dom, Zustand, TanStack Query dependency present, socket.io-client dependency present, recharts dependency present, react-hot-toast, lucide-react). Talks *only* to the backend's `/platform/*` router — the tenant API surface is structurally separate and this app never calls it (§1.7). See `../docs/ARCHITECTURE.md` §T for the full module list.

## Phase 8 status (current)

**Real, wired pages**, verified against the actual running backend over real HTTP (not just Jest — see "How this was verified" below):

- **Overview** — live KPI tiles from `GET /platform/analytics/overview`.
- **Organizations** — list, create (org + its first Org Admin together, matching the backend's atomic onboarding flow), suspend/reinstate.
- **Countries** — reference data list + add (unblocks the Organization creation form's country picker).
- **Locations** — cross-org read-only table.
- **Devices** — cross-org table + platform-level force-deactivate.
- **Anomalies** — cross-org, filterable by risk level, shows the explainable `reasons` list verbatim (§20's "suspicious activity detected — review required" framing, never an accusation).
- **System Health** / **Sync Incidents** — both served by one `IncidentsPage` (the backend has one `Incident` model covering shift-abandoned/sync-conflict/retry-exhausted types, not yet split into a separate latency/queue-depth surface — that's a real Phase 9+ observability concern once there's a deployment to observe).
- **Audit** — cross-org drill-in, filterable by organization.

**Still placeholders** (`PlaceholderPage`, same pattern as everywhere else in this project): Subscriptions, Platform Analytics (beyond the Overview tiles), Support/Ops — none of these have real backend data behind them yet (no billing/subscription-creation flow, no computed analytics aggregates beyond the overview counts, no ticketing system).

**Backend additions this phase required** (the dashboard couldn't exist without them): `GET/POST /platform/countries`, `GET /platform/locations`, `GET /platform/devices` + `POST /platform/devices/:id/deactivate`, `GET /platform/anomalies`, `GET /platform/incidents`, `GET /platform/audit`, `GET /platform/analytics/overview`. Every one of these reads across all tenants deliberately — see each controller's header comment in the backend repo for the `skipOrgScope` reasoning.

**Known gap, stated plainly**: platform-level reads (e.g. viewing a tenant's audit log) are not yet self-audited — `platformAudit.controller.js`'s header explains why (`AuditLog.organizationId` is a required field; a platform-only audit event needs either a schema change or a separate collection, neither done this pass).

### How this was verified

No interactive browser tool was available in this session, so the pages were **not** visually confirmed rendering correctly — that's a real gap, not glossed over. What *was* verified: a real backend was booted (in-memory MongoDB replica set, the actual `server.js`, not a mock), the Vite dev server was started, CORS was confirmed correct for that exact origin, and the precise HTTP calls each page makes (login, overview, countries list, organization list+create) were exercised directly and their response shapes checked against what the React components actually destructure (`res.data.data.X`). That's real end-to-end proof the wiring works — it is not the same claim as "a human looked at this and it looks right."

## Phase 9 status (current)

- **Test suite added** — this repo had zero test tooling through Phase 8, a real gap for a "full test suite" milestone. Added Vitest + React Testing Library (`npm test`): `src/context/__tests__/authStore.test.js` (login/logout state transitions and `localStorage` persistence — the actual branching logic in the platform-admin auth store), plus component tests for `DataTable` and `Badge` (loading/empty/populated states, custom cell renderers, unknown-tone fallback). Deliberately not a wall-to-wall page-level test suite — most pages are thin fetch-and-render wiring already covered by Phase 8's live-HTTP verification (see above); the new tests target the pieces with actual conditional logic.
- **Dependency fixes**: removed `socket.io-client` (confirmed unused via grep — no `io()` call anywhere in `src/`, the same dead dependency the mobile app had); upgraded `react-router-dom` 6.x → 7.18.2, resolving 2 moderate CVEs with no non-breaking patch available on 6.x (build re-verified, 1543 modules, no errors).
- **Known, deliberately not fixed**: a dev-only `esbuild`/`vite` CVE (GHSA-67mh-4wv8-2f99, moderate — a malicious website could reach the Vite dev server's WebSocket during local development) has no non-breaking fix; resolving it requires a Vite 8 major bump, out of scope for this pass. Accepted risk: dev-server-only exposure, not present in the production build served by nginx.
- **Known, out of scope for this repo alone**: the platform-admin JWT is stored in `localStorage` (`src/context/authStore.js`), not an httpOnly cookie — readable by any script that achieves XSS on this origin. The tradeoff: an httpOnly cookie needs the backend to set it (cross-origin cookie handling, `SameSite`/`credentials` config) and moves CSRF into scope instead — a real architecture change, not a one-line fix, so it's surfaced here rather than silently patched.
- **CI**: `.github/workflows/owner-web-ci.yml` — `npm ci`, `npm audit --omit=dev --audit-level=high` (the esbuild/vite finding above is dev-only, so this gate stays meaningful), `npm test`, `npm run build`, on every push/PR touching `owner-web/`.
- **Deployment**: served as a static build by nginx per `../infra/nginx/owner-web.conf` — see `../backend/README.md`'s Phase 9 section for the shared deployment automation notes.

## Local setup

```bash
npm install
npm run dev     # expects the backend on :5100 — see ../backend/README.md
npm run build
```
