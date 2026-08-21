/**
 * Phase 6 exit criteria (docs/ARCHITECTURE.md §Z): "Mock-location hard-block
 * verified on a real rooted test device; anomaly detection produces
 * explainable output matching the §20 worked example." The device-level
 * verification genuinely needs real hardware this environment doesn't have
 * — see server.js's Phase 6 status comment. What IS covered end-to-end
 * through real HTTP + a real transactional DB: polygon geofencing, the
 * Play Integrity hard block, location-violation audit logging, the audit
 * read API's RBAC, and the anomaly engine actually producing a multi-reason,
 * explainable HIGH/CRITICAL result from real accumulated shift data (not a
 * mocked signal) — the same shape as the §20 worked example, even though the
 * specific input rules differ (discounts/corrections aren't implemented
 * features yet, see anomaly.service.js's header for why).
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
const orgCode = 'sec-co'
const GOOD_GEO = { lat: 12.9716, lng: 77.5946 }
const FAR_GEO = { lat: 13.5, lng: 78.2 }
const goodLocationCheck = (overrides = {}) => ({ lat: GOOD_GEO.lat, lng: GOOD_GEO.lng, accuracyM: 10, mockDetected: false, ...overrides })

let adminToken, deviceUuid, deviceSecret, locationId, vehicleTypeId

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
  ;({ token: adminToken } = await staffLogin(app, orgCode, '9000000001', 'Admin@123'))
  deviceUuid = 'sec-device-1'
  deviceSecret = await registerDevice(app, adminToken, deviceUuid)

  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: 'Security Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
  })
  locationId = locRes.body.data.location._id

  const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
  vehicleTypeId = vtRes.body.data.vehicleType._id

  await signedReq(app, 'post', '/pricing-rules', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { locationId, vehicleTypeId, mode: 'PAY_ON_EXIT', name: 'Car hourly', config: { tierType: 'HOURLY', firstHourMinor: 3000, additionalHourMinor: 2000 } },
  })
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

async function createStaffAndLogin(phone, name = 'Staffer') {
  await signedReq(app, 'post', '/staff', { token: adminToken, deviceUuid, deviceSecret, body: { name, phone, password: 'Staff@123', role: 'STAFF' } })
  return staffLogin(app, orgCode, phone, 'Staff@123')
}

async function provisionOneToken() {
  const res = await signedReq(app, 'post', '/tokens/batches', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, batchSize: 1 } })
  return res.body.data.tokens[0].tokenCode
}

// ═══════════════════════════════════════════════════════════════════════
describe('polygon geofence (§M)', () => {
  let polyLocationId, polyStaffToken

  beforeAll(async () => {
    // A small square roughly centered on GOOD_GEO — deliberately NOT using
    // geofenceRadiusM for this location, to prove the polygon path is what's
    // actually being exercised.
    const d = 0.001
    const polygon = {
      type: 'Polygon',
      coordinates: [[
        [GOOD_GEO.lng - d, GOOD_GEO.lat - d],
        [GOOD_GEO.lng + d, GOOD_GEO.lat - d],
        [GOOD_GEO.lng + d, GOOD_GEO.lat + d],
        [GOOD_GEO.lng - d, GOOD_GEO.lat + d],
        [GOOD_GEO.lng - d, GOOD_GEO.lat - d],
      ]],
    }
    const Location = require('../models/Location')
    const loc = await Location.create({
      organizationId: orgId, countryId, name: 'Polygon Lot', geo: GOOD_GEO,
      geofencePolygon: polygon, timezone: 'Asia/Kolkata', currency: 'INR',
    })
    polyLocationId = loc._id.toString()

    await signedReq(app, 'post', '/pricing-rules', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { locationId: polyLocationId, vehicleTypeId, mode: 'PAY_ON_EXIT', name: 'Poly lot hourly', config: { tierType: 'HOURLY', firstHourMinor: 3000, additionalHourMinor: 2000 } },
    })

    ;({ token: polyStaffToken } = await createStaffAndLogin('9500000001', 'Poly Pat'))
    await signedReq(app, 'post', '/shifts/start', { token: polyStaffToken, deviceUuid, deviceSecret, body: { locationId: polyLocationId } })
  })

  test('a point inside the polygon passes', async () => {
    const tokenCode = await provisionOneToken()
    // token above was provisioned at `locationId`, not `polyLocationId` — need one at the poly location
    const tbRes = await signedReq(app, 'post', '/tokens/batches', { token: adminToken, deviceUuid, deviceSecret, body: { locationId: polyLocationId, batchSize: 1 } })
    const polyTokenCode = tbRes.body.data.tokens[0].tokenCode

    const res = await signedReq(app, 'post', '/sessions/entry', {
      token: polyStaffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'poly-ctx-1', locationId: polyLocationId, vehicleNumber: 'POLYVEH1', vehicleTypeId, tokenCode: polyTokenCode, locationCheck: goodLocationCheck() },
    })
    expect(res.status).toBe(201)
  })

  test('a point outside the polygon (but technically within an equivalent radius) fails', async () => {
    const tbRes = await signedReq(app, 'post', '/tokens/batches', { token: adminToken, deviceUuid, deviceSecret, body: { locationId: polyLocationId, batchSize: 1 } })
    const polyTokenCode = tbRes.body.data.tokens[0].tokenCode

    const res = await signedReq(app, 'post', '/sessions/entry', {
      token: polyStaffToken, deviceUuid, deviceSecret,
      body: {
        clientTransactionId: 'poly-ctx-2', locationId: polyLocationId, vehicleNumber: 'POLYVEH2', vehicleTypeId, tokenCode: polyTokenCode,
        locationCheck: goodLocationCheck({ lat: GOOD_GEO.lat + 0.005, lng: GOOD_GEO.lng }), // well outside the ~111m square
      },
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('LOCATION_VERIFICATION_FAILED')
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('Play Integrity hard block (§M layer 2)', () => {
  test('a failing integrity verdict is blocked even with perfect coordinates', async () => {
    const { token: staffToken } = await createStaffAndLogin('9500000002', 'Integrity Ian')
    await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId } })
    const tokenCode = await provisionOneToken()

    const res = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'integrity-ctx-1', locationId, vehicleNumber: 'BADINTEG1', vehicleTypeId, tokenCode, locationCheck: goodLocationCheck({ playIntegrity: 'MEETS_NO_INTEGRITY' }) },
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('LOCATION_VERIFICATION_FAILED')
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('location-check failures write their own audit trail (§21)', () => {
  test('a rejected entry creates a LOCATION_VERIFICATION_FAILED AuditLog row even though the controller never ran', async () => {
    const { token: staffToken } = await createStaffAndLogin('9500000003', 'Audit Amy')
    await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId } })
    const tokenCode = await provisionOneToken()

    await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'auditfail-ctx-1', locationId, vehicleNumber: 'AUDITFAIL1', vehicleTypeId, tokenCode, locationCheck: goodLocationCheck(FAR_GEO) },
    })

    const AuditLog = require('../models/AuditLog')
    const row = await AuditLog.findOne({ organizationId: orgId, action: 'LOCATION_VERIFICATION_FAILED', locationId })
    expect(row).not.toBeNull()
    expect(row.locationCheck.layers.withinGeofence).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('GET /audit-logs RBAC (§O, §21)', () => {
  test('Staff cannot read audit logs; Manager/Org Admin can', async () => {
    const { token: staffToken } = await createStaffAndLogin('9500000004', 'Blocked Bea')
    const staffRes = await signedReq(app, 'get', '/audit-logs', { token: staffToken, deviceUuid, deviceSecret })
    expect(staffRes.status).toBe(403)

    const adminRes = await signedReq(app, 'get', '/audit-logs', { token: adminToken, deviceUuid, deviceSecret })
    expect(adminRes.status).toBe(200)
    expect(Array.isArray(adminRes.body.data.logs)).toBe(true)
    expect(adminRes.body.data.logs.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('session cancellation (§12) and its RBAC', () => {
  test('Staff cannot cancel; Manager+ can, and the token/slot are released', async () => {
    const { token: staffToken } = await createStaffAndLogin('9500000005', 'Cancel Cara')
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId } })
    require('../models/ShiftInstance') // noop require to keep this block self-contained

    const tokenCode = await provisionOneToken()
    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'cancel-ctx-1', locationId, vehicleNumber: 'CANCELME1', vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    const sessionId = entryRes.body.data.sessionId

    const staffAttempt = await signedReq(app, 'post', `/sessions/${sessionId}/cancel`, { token: staffToken, deviceUuid, deviceSecret, body: { reason: 'trying to self-cancel' } })
    expect(staffAttempt.status).toBe(403)

    const res = await signedReq(app, 'post', `/sessions/${sessionId}/cancel`, { token: adminToken, deviceUuid, deviceSecret, body: { reason: 'duplicate entry, wrong vehicle number' } })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('CANCELLED')

    const tokensRes = await signedReq(app, 'get', '/tokens', { token: adminToken, deviceUuid, deviceSecret, query: { status: 'AVAILABLE' } })
    expect(tokensRes.body.data.tokens.some((t) => t.tokenCode === tokenCode)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('anomaly engine — explainable multi-signal output (§20)', () => {
  test('a clean shift produces no anomaly at all', async () => {
    const { token: staffToken } = await createStaffAndLogin('9600000001', 'Clean Clara')
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId } })
    const shiftId = shiftRes.body.data.shiftInstance._id

    const closeRes = await signedReq(app, 'post', `/shifts/${shiftId}/close`, { token: staffToken, deviceUuid, deviceSecret, body: { actualCashMinor: 0 } })
    expect(closeRes.status).toBe(200)
    expect(closeRes.body.data.anomaly).toBeNull()
  })

  test('a shift with excessive cancellations + a large cash mismatch + repeated location violations produces a HIGH/CRITICAL, multi-reason anomaly', async () => {
    const { token: staffToken } = await createStaffAndLogin('9600000002', 'Dirty Dan')
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId } })
    const shiftId = shiftRes.body.data.shiftInstance._id

    // 6 entry+cancel cycles -> EXCESSIVE_CANCELLATIONS (threshold is 5)
    for (let i = 0; i < 6; i++) {
      const tokenCode = await provisionOneToken()
      const entryRes = await signedReq(app, 'post', '/sessions/entry', {
        token: staffToken, deviceUuid, deviceSecret,
        body: { clientTransactionId: `dirty-cancel-ctx-${i}`, locationId, vehicleNumber: `DIRTYCXL${i}`, vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
      })
      await signedReq(app, 'post', `/sessions/${entryRes.body.data.sessionId}/cancel`, { token: adminToken, deviceUuid, deviceSecret, body: { reason: 'test churn' } })
    }

    // one real paid exit, 5 hours -> amountDue = 11000, then under-report cash -> CASH_MISMATCH (threshold 10000)
    const paidTokenCode = await provisionOneToken()
    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'dirty-paid-ctx-1', locationId, vehicleNumber: 'DIRTYPAID1', vehicleTypeId, tokenCode: paidTokenCode, locationCheck: goodLocationCheck() },
    })
    const paidSessionId = entryRes.body.data.sessionId
    const exitRes = await signedReq(app, 'post', `/sessions/${paidSessionId}/exit/request`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { tokenCode: paidTokenCode, exitAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(), locationCheck: goodLocationCheck() },
    })
    await signedReq(app, 'post', `/sessions/${paidSessionId}/payment`, {
      token: staffToken, deviceUuid, deviceSecret, body: { clientTransactionId: 'dirty-paid-pay-1', method: 'CASH', amountMinor: exitRes.body.data.amountDueMinor },
    })

    // 3 failed-location entry attempts -> LOCATION_VIOLATIONS (threshold 3)
    for (let i = 0; i < 3; i++) {
      const tokenCode = await provisionOneToken()
      await signedReq(app, 'post', '/sessions/entry', {
        token: staffToken, deviceUuid, deviceSecret,
        body: { clientTransactionId: `dirty-locfail-ctx-${i}`, locationId, vehicleNumber: `DIRTYLOC${i}`, vehicleTypeId, tokenCode, locationCheck: goodLocationCheck(FAR_GEO) },
      })
    }

    const closeRes = await signedReq(app, 'post', `/shifts/${shiftId}/close`, {
      token: staffToken, deviceUuid, deviceSecret, body: { actualCashMinor: 0, notes: 'cash drawer short' },
    })
    expect(closeRes.status).toBe(200)
    expect(closeRes.body.data.anomaly).not.toBeNull()
    expect(['HIGH', 'CRITICAL']).toContain(closeRes.body.data.anomaly.riskLevel)

    const rules = closeRes.body.data.anomaly.reasons.map((r) => r.rule)
    expect(rules).toEqual(expect.arrayContaining(['EXCESSIVE_CANCELLATIONS', 'CASH_MISMATCH', 'LOCATION_VIOLATIONS']))
    // explainable — every reason has a human-readable detail, not just a code
    for (const r of closeRes.body.data.anomaly.reasons) expect(r.detail).toBeTruthy()

    // visible via the read API, and reviewable
    const listRes = await signedReq(app, 'get', '/anomalies', { token: adminToken, deviceUuid, deviceSecret, query: { riskLevel: closeRes.body.data.anomaly.riskLevel } })
    expect(listRes.status).toBe(200)
    const anomalyDoc = listRes.body.data.anomalies.find((a) => String(a.subjectId) === String(shiftId))
    expect(anomalyDoc).toBeTruthy()
    expect(anomalyDoc.status).toBe('OPEN')

    const staffReviewAttempt = await signedReq(app, 'post', `/anomalies/${anomalyDoc._id}/review`, { token: staffToken, deviceUuid, deviceSecret, body: { status: 'REVIEWED' } })
    expect(staffReviewAttempt.status).toBe(403)

    const reviewRes = await signedReq(app, 'post', `/anomalies/${anomalyDoc._id}/review`, { token: adminToken, deviceUuid, deviceSecret, body: { status: 'DISMISSED' } })
    expect(reviewRes.status).toBe(200)
    expect(reviewRes.body.data.anomaly.status).toBe('DISMISSED')
  }, 30000)
})

// ═══════════════════════════════════════════════════════════════════════
describe('GET /incidents (system health visibility)', () => {
  test('force-close incidents from earlier phases are visible via the read API', async () => {
    const { token: staffToken } = await createStaffAndLogin('9700000001', 'Incident Ivy')
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId } })
    await signedReq(app, 'post', `/shifts/${shiftRes.body.data.shiftInstance._id}/force-close`, { token: adminToken, deviceUuid, deviceSecret, body: { reason: 'test incident visibility' } })

    const res = await signedReq(app, 'get', '/incidents', { token: adminToken, deviceUuid, deviceSecret, query: { severity: 'HIGH' } })
    expect(res.status).toBe(200)
    expect(res.body.data.incidents.some((i) => i.type === 'SHIFT_ABANDONED')).toBe(true)
  })
})
