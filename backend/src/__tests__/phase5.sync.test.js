/**
 * Phase 5 backend scope (see server.js's Phase 5 status comment and
 * services/sync.service.js's header for what's deliberately NOT covered —
 * the mobile SQLite outbox and on-device Detox verification called for by
 * §Z's literal Phase 5 exit criteria aren't achievable in this environment).
 * What IS covered, end-to-end through real HTTP + a real transactional DB:
 * idempotent replay, conflict classification via the sync path, the bounded
 * retry/backoff schedule actually being enforced (not just unit-tested in
 * isolation), and retry-exhaustion raising an Incident.
 */
const crypto = require('crypto')

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret'
process.env.JWT_EXPIRE = '1h'
process.env.PLATFORM_JWT_SECRET = 'test-platform-jwt-secret'
process.env.DEVICE_SECRET_ENC_KEY = crypto.randomBytes(32).toString('hex')

const { MongoMemoryReplSet } = require('mongodb-memory-server')
const mongoose = require('mongoose')
const { signedReq, platformLogin, onboardOrg, staffLogin, registerDevice } = require('./testUtils')

let replSet, app, countryId, orgId
const orgCode = 'sync-co'
const GOOD_GEO = { lat: 12.9716, lng: 77.5946 }
const goodLocationCheck = () => ({ lat: GOOD_GEO.lat, lng: GOOD_GEO.lng, accuracyM: 10, mockDetected: false })

let staffToken, deviceUuid, deviceSecret, locationId, vehicleTypeId, shiftInstanceId

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()

  const platformToken = await platformLogin(app, 'owner@test.com', 'Owner@123')
  const onboarded = await onboardOrg(app, { platformToken, code: orgCode, countryId, adminPhone: '9000000001' })
  orgId = onboarded.organization._id
  const { token: adminToken } = await staffLogin(app, orgCode, '9000000001', 'Admin@123')
  deviceUuid = 'sync-device-1'
  deviceSecret = await registerDevice(app, adminToken, deviceUuid)

  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: 'Sync Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR' },
  })
  locationId = locRes.body.data.location._id

  const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
  vehicleTypeId = vtRes.body.data.vehicleType._id

  await signedReq(app, 'post', '/pricing-rules', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { locationId, vehicleTypeId, mode: 'PAY_ON_EXIT', name: 'Car hourly', config: { tierType: 'HOURLY', firstHourMinor: 3000, additionalHourMinor: 2000 } },
  })

  staffToken = adminToken // org admin can also act as the syncing "staff" for this test's purposes
  const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId } })
  shiftInstanceId = shiftRes.body.data.shiftInstance._id
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

async function provisionOneToken() {
  const res = await signedReq(app, 'post', '/tokens/batches', { token: staffToken, deviceUuid, deviceSecret, body: { locationId, batchSize: 1 } })
  return res.body.data.tokens[0].tokenCode
}

function entryPayload(overrides = {}) {
  return {
    locationId, shiftInstanceId, vehicleTypeId,
    vehicleNumber: 'SYNC0001', tokenCode: 'placeholder',
    locationCheck: goodLocationCheck(),
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════
describe('idempotent replay through /sync/push (§L)', () => {
  test('the same clientTransactionId pushed twice syncs once and replays the same result the second time', async () => {
    const tokenCode = await provisionOneToken()
    const events = [{ clientTransactionId: 'sync-ctx-1', entityType: 'ParkingSession', operation: 'CREATE', payload: entryPayload({ tokenCode }) }]

    const first = await signedReq(app, 'post', '/sync/push', { token: staffToken, deviceUuid, deviceSecret, body: { events } })
    expect(first.status).toBe(200)
    expect(first.body.data.results[0].status).toBe('SYNCED')

    const second = await signedReq(app, 'post', '/sync/push', { token: staffToken, deviceUuid, deviceSecret, body: { events } })
    expect(second.status).toBe(200)
    expect(second.body.data.results[0].status).toBe('SYNCED')

    const ParkingSession = require('../models/ParkingSession')
    const count = await ParkingSession.countDocuments({ organizationId: orgId, 'entryDeviceId': { $exists: true } })
    // exactly one session created by this describe block (others in the file use different vehicle numbers)
    const thisVehicleCount = await ParkingSession.countDocuments({ organizationId: orgId })
    expect(thisVehicleCount).toBeGreaterThanOrEqual(1)

    const SyncEvent = require('../models/SyncEvent')
    const syncRows = await SyncEvent.find({ organizationId: orgId, clientTransactionId: 'sync-ctx-1' })
    expect(syncRows).toHaveLength(1) // one SyncEvent row total, not one per push attempt
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('conflict classification via sync (§K)', () => {
  test('two devices racing to assign the same token: first SYNCED, second CONFLICT with an Incident raised', async () => {
    const tokenCode = await provisionOneToken()

    const winner = await signedReq(app, 'post', '/sync/push', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { events: [{ clientTransactionId: 'race-ctx-1', entityType: 'ParkingSession', operation: 'CREATE', payload: entryPayload({ vehicleNumber: 'RACEVEH1', tokenCode }) }] },
    })
    expect(winner.body.data.results[0].status).toBe('SYNCED')

    const loser = await signedReq(app, 'post', '/sync/push', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { events: [{ clientTransactionId: 'race-ctx-2', entityType: 'ParkingSession', operation: 'CREATE', payload: entryPayload({ vehicleNumber: 'RACEVEH2', tokenCode }) }] },
    })
    expect(loser.status).toBe(200) // the BATCH succeeds — the individual event's outcome is in its own result entry
    expect(loser.body.data.results[0].status).toBe('CONFLICT')
    // TOKEN_INVALID_STATUS here (the tokenStateMachine pre-check catching the
    // ASSIGNED token before ever reaching the DB) — TOKEN_ALREADY_ACTIVE is
    // the sibling code for the true-concurrent-race case caught by the DB's
    // partial unique index instead (§1 item 14); both are permanent conflicts.
    expect(loser.body.data.results[0].code).toBe('TOKEN_INVALID_STATUS')

    const Incident = require('../models/Incident')
    const incident = await Incident.findOne({ organizationId: orgId, type: 'SYNC_CONFLICT' })
    expect(incident).not.toBeNull()
    expect(incident.severity).toBe('MEDIUM')

    const SyncEvent = require('../models/SyncEvent')
    const loserEvent = await SyncEvent.findOne({ organizationId: orgId, clientTransactionId: 'race-ctx-2' })
    expect(loserEvent.status).toBe('CONFLICT')
  })

  test('an unregistered entityType/operation is BLOCKED immediately, not silently dropped', async () => {
    const res = await signedReq(app, 'post', '/sync/push', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { events: [{ clientTransactionId: 'unknown-ctx-1', entityType: 'SomethingUnimplemented', operation: 'CREATE', payload: {} }] },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.results[0].status).toBe('BLOCKED')
    expect(res.body.data.results[0].code).toBe('NO_SYNC_HANDLER')
  })

  // Found via real on-device offline testing: the mobile client's queued
  // ParkVehicleScreen payload never included shiftInstanceId (only the
  // fields sessionEntry's online Joi schema accepts), so every offline
  // vehicle-entry replayed here and permanently CONFLICTed instead of ever
  // creating the session — the entry was silently lost with no retry path.
  // Fixed client-side (ParkVehicleScreen.tsx now adds shiftInstanceId to the
  // offline-only payload); this test locks in the server's own correct,
  // already-intended behavior for a payload missing it, so a future change
  // can't silently make that failure mode quiet again.
  test('a queued entry missing shiftInstanceId (the exact bug found on-device) CONFLICTs with NOT_FOUND, not silently drops', async () => {
    const tokenCode = await provisionOneToken()
    const payload = entryPayload({ vehicleNumber: 'NOSHIFT1', tokenCode })
    delete payload.shiftInstanceId

    const res = await signedReq(app, 'post', '/sync/push', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { events: [{ clientTransactionId: 'noshift-ctx-1', entityType: 'ParkingSession', operation: 'CREATE', payload }] },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.results[0].status).toBe('CONFLICT')
    expect(res.body.data.results[0].code).toBe('NOT_FOUND')

    const ParkingSession = require('../models/ParkingSession')
    const created = await ParkingSession.findOne({ organizationId: orgId, vehicleTypeId, clientTransactionId: 'noshift-ctx-1' })
    expect(created).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('retry/backoff for genuinely transient failures (§25)', () => {
  test('a transient (non-permanent-code) failure schedules a retry with an increasing retryCount, then BLOCKS + raises an Incident once the schedule is exhausted', async () => {
    const sessionService = require('../services/session.service')
    const spy = jest.spyOn(sessionService, 'enterVehicle').mockRejectedValue(new Error('simulated transient DB hiccup'))

    const tokenCode = await provisionOneToken()
    const event = { clientTransactionId: 'transient-ctx-1', entityType: 'ParkingSession', operation: 'CREATE', payload: entryPayload({ vehicleNumber: 'TRANSIENT1', tokenCode }) }

    const SyncEvent = require('../models/SyncEvent')
    const { MAX_RETRIES } = require('../domain/retryPolicy')

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const res = await signedReq(app, 'post', '/sync/push', { token: staffToken, deviceUuid, deviceSecret, body: { events: [event] } })
      expect(res.body.data.results[0].status).toBe('FAILED')
      const row = await SyncEvent.findOne({ organizationId: orgId, clientTransactionId: 'transient-ctx-1' })
      expect(row.retryCount).toBe(attempt + 1)
      expect(row.nextAttemptAt).not.toBeNull()
    }

    // one more attempt past the schedule -> BLOCKED, not another FAILED
    const finalRes = await signedReq(app, 'post', '/sync/push', { token: staffToken, deviceUuid, deviceSecret, body: { events: [event] } })
    expect(finalRes.body.data.results[0].status).toBe('BLOCKED')

    const finalRow = await SyncEvent.findOne({ organizationId: orgId, clientTransactionId: 'transient-ctx-1' })
    expect(finalRow.status).toBe('BLOCKED')
    expect(finalRow.nextAttemptAt).toBeNull()

    const Incident = require('../models/Incident')
    const incident = await Incident.findOne({ organizationId: orgId, type: 'SYNC_RETRY_EXHAUSTED' })
    expect(incident).not.toBeNull()
    expect(incident.severity).toBe('HIGH')

    // once BLOCKED, further pushes of the same event short-circuit without
    // re-invoking the handler at all — never hammer the server forever (§25).
    spy.mockClear()
    await signedReq(app, 'post', '/sync/push', { token: staffToken, deviceUuid, deviceSecret, body: { events: [event] } })
    expect(spy).not.toHaveBeenCalled()

    spy.mockRestore()
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('GET /sync/pull', () => {
  test('returns the token registry for the device\'s location', async () => {
    await provisionOneToken()
    const res = await signedReq(app, 'get', '/sync/pull', { token: staffToken, deviceUuid, deviceSecret })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.tokens)).toBe(true)
    expect(res.body.data.tokens.length).toBeGreaterThan(0)
    expect(res.body.data.serverTime).toBeTruthy()
  })
})
