/**
 * Phase 3 exit criteria (docs/ARCHITECTURE.md §Z): "Full entry->exit happy
 * path plus the state-machine illegal-transition tests (§F/§G/§I) all pass."
 * Black-box, through Supertest against the real Express app + a real
 * in-memory MongoDB replica set — the whole point being that this exercises
 * the actual multi-document transactions (token+slot+session+payment) the
 * way production will, not a mocked-out shortcut.
 */
const crypto = require('crypto')

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret'
process.env.JWT_EXPIRE = '1h'
process.env.PLATFORM_JWT_SECRET = 'test-platform-jwt-secret'
process.env.DEVICE_SECRET_ENC_KEY = crypto.randomBytes(32).toString('hex')

const { MongoMemoryReplSet } = require('mongodb-memory-server')
const mongoose = require('mongoose')
const request = require('supertest')
const { signedReq, platformLogin, onboardOrg, staffLogin, registerDevice } = require('./testUtils')

let replSet
let app
let countryId

// Fixtures shared across the whole file, populated in the outer beforeAll.
let orgCode = 'lot-co'
let adminToken, staffToken
let deviceUuid = 'shared-device-1'
let deviceSecret
let locationId
let carVehicleTypeId, bikeVehicleTypeId
let carPricingRuleId, bikePricingRuleId
let shiftInstanceId

const GOOD_GEO = { lat: 12.9716, lng: 77.5946 }
const FAR_GEO = { lat: 13.5, lng: 78.2 } // ~70km away — well outside any geofence

function goodLocationCheck(overrides = {}) {
  return { lat: GOOD_GEO.lat, lng: GOOD_GEO.lng, accuracyM: 10, mockDetected: false, ...overrides }
}

async function provisionOneToken(locId) {
  const res = await signedReq(app, 'post', '/tokens/batches', {
    token: adminToken, deviceUuid, deviceSecret, body: { locationId: locId, batchSize: 1 },
  })
  expect(res.status).toBe(201)
  return res.body.data.tokens[0].tokenCode
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  // Requiring server.js registers every model via its route requires; mirror
  // config/db.js's production boot behavior here since this test manages its
  // own connection rather than going through connectDb() — see that file's
  // comment for why waiting on this matters (§1 items 13-14's guarantees).
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()

  const platformToken = await platformLogin(app, 'owner@test.com', 'Owner@123')
  await onboardOrg(app, { platformToken, code: orgCode, countryId, adminPhone: '9000000001' })
  ;({ token: adminToken } = await staffLogin(app, orgCode, '9000000001', 'Admin@123'))
  deviceSecret = await registerDevice(app, adminToken, deviceUuid)

  // Location
  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: 'Main Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
  })
  expect(locRes.status).toBe(201)
  locationId = locRes.body.data.location._id

  // Vehicle types
  const carRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
  carVehicleTypeId = carRes.body.data.vehicleType._id
  const bikeRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'BIKE', name: 'Bike' } })
  bikeVehicleTypeId = bikeRes.body.data.vehicleType._id

  // Pricing: CAR = PAY_ON_EXIT, HOURLY (first hour Rs30, +Rs20/hr — same worked example as §10)
  const carRule = await signedReq(app, 'post', '/pricing-rules', {
    token: adminToken, deviceUuid, deviceSecret,
    body: {
      locationId, vehicleTypeId: carVehicleTypeId, mode: 'PAY_ON_EXIT', name: 'Car hourly',
      config: { tierType: 'HOURLY', firstHourMinor: 3000, additionalHourMinor: 2000 },
    },
  })
  expect(carRule.status).toBe(201)
  carPricingRuleId = carRule.body.data.pricingRule._id

  // Pricing: BIKE = PAY_ON_ENTRY, flat Rs20
  const bikeRule = await signedReq(app, 'post', '/pricing-rules', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { locationId, vehicleTypeId: bikeVehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Bike flat', config: { flatAmountMinor: 2000 } },
  })
  expect(bikeRule.status).toBe(201)
  bikePricingRuleId = bikeRule.body.data.pricingRule._id

  // Staff + shift (staff shares the same registered device, a legitimate
  // setup — a device belongs to the org/location, not to one individual)
  const staffRes = await signedReq(app, 'post', '/staff', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { name: 'Staff Sam', phone: '9000000003', password: 'Staff@123', role: 'STAFF' },
  })
  expect(staffRes.status).toBe(201)
  ;({ token: staffToken } = await staffLogin(app, orgCode, '9000000003', 'Staff@123'))

  const shiftRes = await signedReq(app, 'post', '/shifts/start', {
    token: staffToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 },
  })
  expect(shiftRes.status).toBe(201)
  shiftInstanceId = shiftRes.body.data.shiftInstance._id
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

// ═══════════════════════════════════════════════════════════════════════
describe('PAY_ON_EXIT happy path (§9, §12, the default mode)', () => {
  let tokenCode, sessionId, entryAt

  test('entry: vehicle parked, session goes straight to ACTIVE', async () => {
    tokenCode = await provisionOneToken(locationId)
    entryAt = new Date()

    const res = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: {
        clientTransactionId: 'ctx-entry-1',
        locationId, vehicleNumber: 'ka 01 ab 1234', vehicleTypeId: carVehicleTypeId, tokenCode,
        entryAt: entryAt.toISOString(), locationCheck: goodLocationCheck(),
      },
    })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('ACTIVE')
    expect(res.body.data.amountDueMinor).toBeNull()
    sessionId = res.body.data.sessionId
  })

  test('a retried entry with the SAME clientTransactionId is idempotent, not a duplicate (§L)', async () => {
    const res = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: {
        clientTransactionId: 'ctx-entry-1', // same key as above, different vehicle/token to prove it's ignored
        locationId, vehicleNumber: 'DIFFERENT', vehicleTypeId: carVehicleTypeId, tokenCode: 'DOES-NOT-EXIST',
        locationCheck: goodLocationCheck(),
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.sessionId).toBe(sessionId)
  })

  test('GET /sessions/by-token/:tokenCode resolves the token scanned at exit back to this session (§7 mobile app support)', async () => {
    const res = await signedReq(app, 'get', `/sessions/by-token/${tokenCode}`, { token: staffToken, deviceUuid, deviceSecret })
    expect(res.status).toBe(200)
    expect(res.body.data.session._id).toBe(sessionId)
    expect(res.body.data.session.vehicleId.vehicleNumber).toBe('KA01AB1234') // populated for the exit screen to display
  })

  test('GET /sessions/by-token/:tokenCode 404s for a token with no active session', async () => {
    const res = await signedReq(app, 'get', '/sessions/by-token/NOT-A-REAL-CODE', { token: staffToken, deviceUuid, deviceSecret })
    expect(res.status).toBe(404)
  })

  test('exit request: amount computed correctly (90 min -> Rs30 first hour + Rs20 second hour = Rs50)', async () => {
    const exitAt = new Date(entryAt.getTime() + 90 * 60 * 1000)
    const res = await signedReq(app, 'post', `/sessions/${sessionId}/exit/request`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { tokenCode, exitAt: exitAt.toISOString(), locationCheck: goodLocationCheck() },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('PAYMENT_PENDING')
    expect(res.body.data.amountDueMinor).toBe(5000)
    expect(res.body.data.durationMinutes).toBe(90)
  })

  test('payment completes the session and releases the token', async () => {
    const res = await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-payment-1', method: 'CASH', amountMinor: 5000 },
    })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('PAID')
    expect(res.body.data.sessionStatus).toBe('COMPLETED')

    const tokensRes = await signedReq(app, 'get', '/tokens', { token: adminToken, deviceUuid, deviceSecret, query: { status: 'AVAILABLE' } })
    expect(tokensRes.body.data.tokens.some(t => t.tokenCode === tokenCode)).toBe(true)
  })

  test('§1 item 14 / §F: a second exit attempt on the same (now COMPLETED) session is rejected, not double-processed', async () => {
    const res = await signedReq(app, 'post', `/sessions/${sessionId}/exit/request`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { tokenCode, exitAt: new Date().toISOString(), locationCheck: goodLocationCheck() },
    })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('SESSION_ALREADY_TERMINAL')
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('PAY_ON_ENTRY happy path (§F: amount known and captured before ACTIVE)', () => {
  test('entry leaves the session at PAYMENT_PENDING with the flat amount, not ACTIVE', async () => {
    const tokenCode = await provisionOneToken(locationId)
    const res = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: {
        clientTransactionId: 'ctx-entry-bike-1',
        locationId, vehicleNumber: 'KA05XY9999', vehicleTypeId: bikeVehicleTypeId, tokenCode,
        locationCheck: goodLocationCheck(),
      },
    })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('PAYMENT_PENDING')
    expect(res.body.data.amountDueMinor).toBe(2000)

    const sessionId = res.body.data.sessionId

    const payRes = await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-payment-bike-1', method: 'UPI', amountMinor: 2000 },
    })
    expect(payRes.status).toBe(201)
    expect(payRes.body.data.sessionStatus).toBe('ACTIVE') // PAID -> ACTIVE for entry-priced modes, not COMPLETED

    const exitRes = await signedReq(app, 'post', `/sessions/${sessionId}/exit/request`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { tokenCode, exitAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), locationCheck: goodLocationCheck() },
    })
    expect(exitRes.status).toBe(200)
    expect(exitRes.body.data.status).toBe('COMPLETED') // straight through, already paid at entry
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('illegal-transition / anomaly rejections (§F, §G, §1)', () => {
  test('a token already ASSIGNED/ACTIVE elsewhere cannot be assigned to a second session', async () => {
    const tokenCode = await provisionOneToken(locationId)
    const first = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-race-1', locationId, vehicleNumber: 'RACE0001', vehicleTypeId: carVehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    expect(first.status).toBe(201)

    const second = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-race-2', locationId, vehicleNumber: 'RACE0002', vehicleTypeId: carVehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    expect(second.status).toBe(409)
    expect(second.body.code).toBe('TOKEN_INVALID_STATUS')
  })

  test('§1 item 13: a vehicle already active cannot be entered again under a different token', async () => {
    const tokenA = await provisionOneToken(locationId)
    const tokenB = await provisionOneToken(locationId)

    const first = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-dupveh-1', locationId, vehicleNumber: 'DUPVEH01', vehicleTypeId: carVehicleTypeId, tokenCode: tokenA, locationCheck: goodLocationCheck() },
    })
    expect(first.status).toBe(201)

    const second = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-dupveh-2', locationId, vehicleNumber: 'dupveh01', vehicleTypeId: carVehicleTypeId, tokenCode: tokenB, locationCheck: goodLocationCheck() },
    })
    expect(second.status).toBe(409)
    expect(second.body.code).toBe('VEHICLE_ALREADY_ACTIVE')
  })

  test('§14: entry is blocked without an active shift', async () => {
    // Fresh staff, never started a shift
    await signedReq(app, 'post', '/staff', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { name: 'No Shift Nick', phone: '9000000004', password: 'NoShift@123', role: 'STAFF' },
    })
    const { token: noShiftToken } = await staffLogin(app, orgCode, '9000000004', 'NoShift@123')
    const tokenCode = await provisionOneToken(locationId)

    const res = await signedReq(app, 'post', '/sessions/entry', {
      token: noShiftToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-noshift-1', locationId, vehicleNumber: 'NOSHIFT01', vehicleTypeId: carVehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('SHIFT_NOT_ACTIVE')
  })

  test('§M: entry is blocked when the reported location is outside the geofence', async () => {
    const tokenCode = await provisionOneToken(locationId)
    const res = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-farloc-1', locationId, vehicleNumber: 'FARLOC001', vehicleTypeId: carVehicleTypeId, tokenCode, locationCheck: goodLocationCheck(FAR_GEO) },
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('LOCATION_VERIFICATION_FAILED')
  })

  test('§1 item 4: mock-location is an UNCONDITIONAL hard block, even with otherwise-correct coordinates', async () => {
    const tokenCode = await provisionOneToken(locationId)
    const res = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-mock-1', locationId, vehicleNumber: 'MOCKGPS01', vehicleTypeId: carVehicleTypeId, tokenCode, locationCheck: goodLocationCheck({ mockDetected: true }) },
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('LOCATION_VERIFICATION_FAILED')
  })

  test('a token belonging to a different location is rejected', async () => {
    // second location, same org
    const otherLocRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: 'Other Lot', geo: FAR_GEO, timezone: 'Asia/Kolkata', currency: 'INR' },
    })
    const otherLocationId = otherLocRes.body.data.location._id
    const otherToken = await provisionOneToken(otherLocationId)

    const res = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-wrongloc-1', locationId, vehicleNumber: 'WRONGLOC1', vehicleTypeId: carVehicleTypeId, tokenCode: otherToken, locationCheck: goodLocationCheck() },
    })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TOKEN_LOCATION_MISMATCH')
  })
})
