/**
 * §Z Phase 9 exit criterion: "Load test sustains a simulated outage-recovery
 * burst." This is a standalone script, not a jest test — it boots the real
 * app (via the same MongoMemoryReplSet pattern the integration tests use, so
 * writes go through real multi-document transactions, not a mock) and then
 * fires actual concurrent HTTP traffic at it with Node's built-in fetch, no
 * external load-test tool required (k6/docker aren't available in this
 * environment; autocannon's static request templating doesn't fit well
 * either, since every simulated event needs a unique clientTransactionId/
 * vehicleNumber/tokenCode — a hand-rolled concurrent Promise batch gives full
 * control over that instead).
 *
 * Scenario: N_DEVICES staff devices were offline (no connectivity) and each
 * queued EVENTS_PER_DEVICE vehicle-entry events locally. Connectivity comes
 * back for all of them at once (e.g. a wifi/router recovery at the location)
 * and every device's outbox drains through POST /sync/push in the same few
 * seconds — the worst case the retry/backoff design (§25) and the DB's
 * transactional writes have to absorb simultaneously. A concurrent stream of
 * ordinary read traffic (GET /shifts/current) runs at the same time, to
 * prove the burst doesn't starve unrelated requests.
 *
 * Deliberately kept under the general rate limiter's cap (2000 req / 15 min
 * per IP, server.js) — every simulated device in this script shares one
 * process's IP, unlike production where each device is normally on its own
 * connection. That's a real, worth-stating limitation of this test (see
 * backend/README.md's Phase 9 section): it cannot exercise what happens if
 * a genuinely large fleet recovers behind one shared NAT/corporate wifi and
 * collectively exceeds the per-IP cap — only that a burst below the cap is
 * absorbed cleanly.
 */
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'loadtest-jwt-secret'
process.env.JWT_EXPIRE = '1h'
process.env.PLATFORM_JWT_SECRET = 'loadtest-platform-jwt-secret'
process.env.DEVICE_SECRET_ENC_KEY = require('crypto').randomBytes(32).toString('hex')

const crypto = require('crypto')
const { MongoMemoryReplSet } = require('mongodb-memory-server')
const mongoose = require('mongoose')

const N_DEVICES = 150
const EVENTS_PER_DEVICE = 5
const CONCURRENT_READERS = 100
const TOTAL_SYNC_REQUESTS = N_DEVICES
const TOTAL_REQUESTS = TOTAL_SYNC_REQUESTS + CONCURRENT_READERS

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

function signRequest({ method, path, body, deviceSecret }) {
  const timestamp = Date.now().toString()
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex')
  const toSign = `${method.toUpperCase()}:${path}:${timestamp}:${bodyHash}`
  const signature = crypto.createHmac('sha256', deviceSecret).update(toSign).digest('hex')
  return { timestamp, signature }
}

async function signedFetch(baseUrl, method, path, { token, deviceUuid, deviceSecret, body }) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (deviceUuid && deviceSecret) {
    const { timestamp, signature } = signRequest({ method, path, body, deviceSecret })
    headers['X-Device-Id'] = deviceUuid
    headers['X-Device-Timestamp'] = timestamp
    headers['X-Device-Signature'] = signature
  }
  const started = performance.now()
  let res, json, error
  try {
    res = await fetch(baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
    json = await res.json().catch(() => ({}))
  } catch (e) {
    error = e
  }
  const durationMs = performance.now() - started
  return { status: res?.status, body: json, durationMs, error }
}

async function main() {
  console.log(`Outage-recovery burst load test — ${N_DEVICES} devices x ${EVENTS_PER_DEVICE} queued events, ${CONCURRENT_READERS} concurrent reads, ${TOTAL_REQUESTS} total requests.\n`)

  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  const { app } = require('../src/server')
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const server = app.listen(0)
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  const PlatformAdmin = require('../src/models/PlatformAdmin')
  const Country = require('../src/models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner@loadtest.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })

  const platformLoginRes = await signedFetch(baseUrl, 'post', '/platform/auth/login', { body: { email: 'owner@loadtest.com', password: 'Owner@123' } })
  const platformToken = platformLoginRes.body.data.token

  const onboardRes = await signedFetch(baseUrl, 'post', '/platform/organizations', {
    token: platformToken,
    body: {
      name: 'Load Test Co', code: 'loadco', countryId: country._id.toString(),
      defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata',
      orgAdmin: { name: 'Admin', phone: '9000000001', password: 'Admin@123' },
    },
  })
  if (onboardRes.status !== 201) throw new Error(`onboardOrg failed: ${JSON.stringify(onboardRes.body)}`)

  const adminLoginRes = await signedFetch(baseUrl, 'post', '/auth/staff/login', { body: { orgCode: 'loadco', phone: '9000000001', password: 'Admin@123' } })
  const adminToken = adminLoginRes.body.data.token
  const deviceUuid = 'loadtest-device-admin'
  const deviceRegRes = await signedFetch(baseUrl, 'post', '/devices/register', { token: adminToken, body: { deviceUuid, platform: 'ANDROID' } })
  const deviceSecret = deviceRegRes.body.data.deviceSecret

  const GOOD_GEO = { lat: 12.9716, lng: 77.5946 }
  const locRes = await signedFetch(baseUrl, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId: country._id.toString(), name: 'Load Test Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR' },
  })
  const locationId = locRes.body.data.location._id

  const vtRes = await signedFetch(baseUrl, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
  const vehicleTypeId = vtRes.body.data.vehicleType._id

  await signedFetch(baseUrl, 'post', '/pricing-rules', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { locationId, vehicleTypeId, mode: 'PAY_ON_EXIT', name: 'Car hourly', config: { tierType: 'HOURLY', firstHourMinor: 3000, additionalHourMinor: 2000 } },
  })

  const shiftRes = await signedFetch(baseUrl, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId } })
  const shiftInstanceId = shiftRes.body.data.shiftInstance._id

  const totalTokensNeeded = N_DEVICES * EVENTS_PER_DEVICE
  const tokenBatchRes = await signedFetch(baseUrl, 'post', '/tokens/batches', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, batchSize: totalTokensNeeded } })
  const tokenCodes = tokenBatchRes.body.data.tokens.map((t) => t.tokenCode)
  if (tokenCodes.length !== totalTokensNeeded) throw new Error(`Expected ${totalTokensNeeded} tokens, got ${tokenCodes.length}`)

  // Each simulated device is a genuinely-registered device with its own
  // HMAC secret (matching production, where every staff phone registers
  // itself once) — registration happens here, in setup, not inside the
  // timed burst below.
  const deviceSecrets = await Promise.all(
    Array.from({ length: N_DEVICES }, (_, i) =>
      signedFetch(baseUrl, 'post', '/devices/register', { token: adminToken, body: { deviceUuid: `loadtest-device-${i}`, platform: 'ANDROID' } })
        .then((r) => {
          if (r.status !== 201) throw new Error(`device ${i} registration failed: ${r.status} ${JSON.stringify(r.body)}`)
          return r.body.data.deviceSecret
        })
    )
  )

  console.log('Setup complete. Firing burst...\n')

  const goodLocationCheck = () => ({ lat: GOOD_GEO.lat, lng: GOOD_GEO.lng, accuracyM: 10, mockDetected: false })

  const syncPromises = Array.from({ length: N_DEVICES }, (_, deviceIdx) => {
    const events = Array.from({ length: EVENTS_PER_DEVICE }, (_, eventIdx) => {
      const flatIdx = deviceIdx * EVENTS_PER_DEVICE + eventIdx
      return {
        clientTransactionId: `burst-${deviceIdx}-${eventIdx}-${crypto.randomUUID()}`,
        entityType: 'ParkingSession',
        operation: 'CREATE',
        payload: {
          locationId, shiftInstanceId, vehicleTypeId,
          vehicleNumber: `LOAD${String(flatIdx).padStart(5, '0')}`,
          tokenCode: tokenCodes[flatIdx],
          locationCheck: goodLocationCheck(),
        },
      }
    })
    return signedFetch(baseUrl, 'post', '/sync/push', { token: adminToken, deviceUuid: `loadtest-device-${deviceIdx}`, deviceSecret: deviceSecrets[deviceIdx], body: { events } })
      .then((r) => ({ kind: 'sync', ...r }))
  })

  const readPromises = Array.from({ length: CONCURRENT_READERS }, () =>
    signedFetch(baseUrl, 'get', '/shifts/current', { token: adminToken, deviceUuid, deviceSecret })
      .then((r) => ({ kind: 'read', ...r }))
  )

  const burstStarted = performance.now()
  const results = await Promise.all([...syncPromises, ...readPromises])
  const burstDurationMs = performance.now() - burstStarted

  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b)
  const p50 = percentile(durations, 50)
  const p95 = percentile(durations, 95)
  const p99 = percentile(durations, 99)
  const max = durations[durations.length - 1]

  const networkErrors = results.filter((r) => r.error)
  const httpErrors = results.filter((r) => !r.error && (r.status < 200 || r.status >= 500))
  const syncResults = results.filter((r) => r.kind === 'sync')
  const readResults = results.filter((r) => r.kind === 'read')

  let eventsSynced = 0, eventsConflict = 0, eventsOther = 0
  for (const r of syncResults) {
    for (const eventResult of r.body?.data?.results || []) {
      if (eventResult.status === 'SYNCED') eventsSynced++
      else if (eventResult.status === 'CONFLICT') eventsConflict++
      else eventsOther++
    }
  }
  const readsOk = readResults.filter((r) => r.status === 200).length

  console.log('── Results ──────────────────────────────────────────────')
  console.log(`Wall-clock burst duration:  ${burstDurationMs.toFixed(0)} ms`)
  console.log(`Total HTTP requests:        ${results.length} (${syncResults.length} sync pushes + ${readResults.length} reads)`)
  console.log(`Latency p50/p95/p99/max:    ${p50.toFixed(0)}ms / ${p95.toFixed(0)}ms / ${p99.toFixed(0)}ms / ${max.toFixed(0)}ms`)
  console.log('  (informational only — see note below, not a pass/fail gate)')
  console.log(`Network errors:             ${networkErrors.length}`)
  console.log(`HTTP 5xx / unexpected:      ${httpErrors.length}`)
  console.log(`Sync events SYNCED:         ${eventsSynced} / ${N_DEVICES * EVENTS_PER_DEVICE}`)
  console.log(`Sync events CONFLICT:       ${eventsConflict}`)
  console.log(`Sync events other:          ${eventsOther}`)
  console.log(`Concurrent reads OK (200):  ${readsOk} / ${CONCURRENT_READERS}`)
  console.log('─────────────────────────────────────────────────────────\n')

  const ParkingSession = require('../src/models/ParkingSession')
  const dbCount = await ParkingSession.countDocuments({ organizationId: onboardRes.body.data.organization._id })
  console.log(`Sessions actually persisted in DB: ${dbCount} (expected ${N_DEVICES * EVENTS_PER_DEVICE})`)

  await server.close()
  await mongoose.disconnect()
  await replSet.stop()

  const failures = []
  if (networkErrors.length > 0) failures.push(`${networkErrors.length} network-level errors (connection refused/reset under load)`)
  if (httpErrors.length > 0) failures.push(`${httpErrors.length} HTTP 5xx/unexpected responses`)
  if (eventsSynced !== N_DEVICES * EVENTS_PER_DEVICE) failures.push(`only ${eventsSynced}/${N_DEVICES * EVENTS_PER_DEVICE} events reached SYNCED (expected all — no legitimate conflicts in this scenario, all vehicle numbers/tokens are unique)`)
  if (dbCount !== N_DEVICES * EVENTS_PER_DEVICE) failures.push(`DB session count (${dbCount}) doesn't match synced event count — possible lost write`)
  if (readsOk !== CONCURRENT_READERS) failures.push(`${CONCURRENT_READERS - readsOk} concurrent reads did not return 200 — burst starved unrelated traffic`)

  console.log('\nNote on latency numbers: this harness runs the app against a single')
  console.log('embedded mongod (MongoMemoryReplSet, one node, no real replication) on')
  console.log('a dev laptop, sharing CPU/disk with the Node process issuing the load —')
  console.log('a correctness-testing tool, not a performance benchmark. Absolute p95/p99')
  console.log('numbers above are informational only and are NOT a production capacity')
  console.log('claim; there is no empirical baseline from real deployment hardware to')
  console.log('threshold them against, so this script does not gate on them. What it DOES')
  console.log('assert (and gate on) is correctness under concurrent load: every event')
  console.log('lands exactly once, no request errors, no lost writes, and ordinary read')
  console.log('traffic is not starved by the sync burst.')

  if (failures.length > 0) {
    console.log('\nFAIL:')
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  console.log('\nPASS: outage-recovery burst absorbed correctly — every queued event synced exactly once, no errors, no lost writes, concurrent reads unaffected.')
  process.exit(0)
}

main().catch((err) => {
  console.error('Load test crashed:', err)
  process.exit(1)
})
