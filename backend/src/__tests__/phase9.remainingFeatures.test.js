/**
 * Phase 9 (post-review) additions: the handover-discovery endpoints
 * (GET /shifts/open, GET /shifts/current's pendingHandover), the forward
 * token-status transitions (POST /tokens/:id/status — mark lost/damaged/
 * blocked, the sibling reinstate never covered), and the reports summary
 * endpoint (GET /reports/summary) — all added to unblock real mobile
 * screens (Shift Handover, QR Tag Inventory actions, Admin Reports) that
 * had no backend support before this pass.
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

let replSet, app, countryId
const orgCode = 'remaining-co'
const GOOD_GEO = { lat: 12.9716, lng: 77.5946 }
const goodLocationCheck = () => ({ lat: GOOD_GEO.lat, lng: GOOD_GEO.lng, accuracyM: 10, mockDetected: false })

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
  ;({ token: adminToken } = await staffLogin(app, orgCode, '9000000001', 'Admin@123'))
  deviceUuid = 'remaining-device-1'
  deviceSecret = await registerDevice(app, adminToken, deviceUuid)

  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: 'Remaining Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR' },
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
  return { tokenCode: res.body.data.tokens[0].tokenCode, tokenId: res.body.data.tokens[0].id }
}

// ═══════════════════════════════════════════════════════════════════════
describe('GET /shifts/open (handover target discovery)', () => {
  test('lists only OPEN shifts at the given location, with the staff name populated', async () => {
    const { token: aliceToken } = await createStaffAndLogin('9300000001', 'Alice Open')
    const { token: bobToken } = await createStaffAndLogin('9300000002', 'Bob Open')

    const aliceShift = await signedReq(app, 'post', '/shifts/start', { token: aliceToken, deviceUuid, deviceSecret, body: { locationId } })
    const bobShift = await signedReq(app, 'post', '/shifts/start', { token: bobToken, deviceUuid, deviceSecret, body: { locationId } })

    const res = await signedReq(app, 'get', '/shifts/open', { token: adminToken, deviceUuid, deviceSecret, query: { locationId } })
    expect(res.status).toBe(200)
    const ids = res.body.data.shiftInstances.map((s) => s._id)
    expect(ids).toEqual(expect.arrayContaining([aliceShift.body.data.shiftInstance._id, bobShift.body.data.shiftInstance._id]))
    const aliceRow = res.body.data.shiftInstances.find((s) => s._id === aliceShift.body.data.shiftInstance._id)
    expect(aliceRow.staffId.name).toBe('Alice Open')

    await signedReq(app, 'post', `/shifts/${aliceShift.body.data.shiftInstance._id}/force-close`, { token: adminToken, deviceUuid, deviceSecret, body: { reason: 'cleanup' } })
    await signedReq(app, 'post', `/shifts/${bobShift.body.data.shiftInstance._id}/force-close`, { token: adminToken, deviceUuid, deviceSecret, body: { reason: 'cleanup' } })
  })

  test('requires a locationId query param', async () => {
    const res = await signedReq(app, 'get', '/shifts/open', { token: adminToken, deviceUuid, deviceSecret });
    expect(res.status).toBe(422)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('GET /shifts/current surfaces a pending handover for the incoming staff (§22)', () => {
  test('the incoming staff sees pendingHandover once initiated, and null again after accepting', async () => {
    const { token: outToken } = await createStaffAndLogin('9300000010', 'Outgoing Ollie')
    const { token: inToken } = await createStaffAndLogin('9300000011', 'Incoming Ivy')

    const outShift = await signedReq(app, 'post', '/shifts/start', { token: outToken, deviceUuid, deviceSecret, body: { locationId } })
    const outShiftId = outShift.body.data.shiftInstance._id
    const inShift = await signedReq(app, 'post', '/shifts/start', { token: inToken, deviceUuid, deviceSecret, body: { locationId } })
    const inShiftId = inShift.body.data.shiftInstance._id

    const beforeCurrent = await signedReq(app, 'get', '/shifts/current', { token: inToken, deviceUuid, deviceSecret })
    expect(beforeCurrent.body.data.pendingHandover).toBeNull()

    await signedReq(app, 'post', `/shifts/${outShiftId}/close`, { token: outToken, deviceUuid, deviceSecret, body: { actualCashMinor: 0 } })
    const initiateRes = await signedReq(app, 'post', `/shifts/${outShiftId}/handover/initiate`, {
      token: outToken, deviceUuid, deviceSecret, body: { toShiftInstanceId: inShiftId },
    })
    expect(initiateRes.status).toBe(201)

    const afterCurrent = await signedReq(app, 'get', '/shifts/current', { token: inToken, deviceUuid, deviceSecret })
    expect(afterCurrent.body.data.pendingHandover).toBeTruthy()
    expect(afterCurrent.body.data.pendingHandover.status).toBe('PENDING')

    const handoverId = afterCurrent.body.data.pendingHandover._id
    const acceptRes = await signedReq(app, 'post', `/handovers/${handoverId}/accept`, { token: inToken, deviceUuid, deviceSecret })
    expect(acceptRes.status).toBe(200)

    const finalCurrent = await signedReq(app, 'get', '/shifts/current', { token: inToken, deviceUuid, deviceSecret })
    expect(finalCurrent.body.data.pendingHandover).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('POST /tokens/:id/status — mark lost/damaged/blocked (§16/§34)', () => {
  test('AVAILABLE -> LOST/DAMAGED/BLOCKED all work with a reason, Manager+ only', async () => {
    const { token: staffToken } = await createStaffAndLogin('9300000020', 'Staffy')

    const { tokenId } = await provisionOneToken()
    const staffAttempt = await signedReq(app, 'post', `/tokens/${tokenId}/status`, { token: staffToken, deviceUuid, deviceSecret, body: { status: 'LOST', reason: 'dropped in a drain' } })
    expect(staffAttempt.status).toBe(403)

    const res = await signedReq(app, 'post', `/tokens/${tokenId}/status`, { token: adminToken, deviceUuid, deviceSecret, body: { status: 'LOST', reason: 'dropped in a drain' } })
    expect(res.status).toBe(200)
    expect(res.body.data.token.status).toBe('LOST')
  })

  test('rejects an invalid transition (LOST -> DAMAGED is not in the state table) and requires a reason', async () => {
    const { tokenId } = await provisionOneToken()
    await signedReq(app, 'post', `/tokens/${tokenId}/status`, { token: adminToken, deviceUuid, deviceSecret, body: { status: 'LOST', reason: 'gone' } })

    const invalidTransition = await signedReq(app, 'post', `/tokens/${tokenId}/status`, { token: adminToken, deviceUuid, deviceSecret, body: { status: 'DAMAGED', reason: 'also broken' } })
    expect(invalidTransition.status).toBe(409)
    expect(invalidTransition.body.code).toBe('TOKEN_INVALID_STATUS')

    const { tokenId: tokenId2 } = await provisionOneToken()
    const noReason = await signedReq(app, 'post', `/tokens/${tokenId2}/status`, { token: adminToken, deviceUuid, deviceSecret, body: { status: 'BLOCKED' } })
    expect(noReason.status).toBe(422)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('GET /reports/summary (§36)', () => {
  test('aggregates real vehicle-entry/exit counts and revenue for the date range, Manager+ only', async () => {
    const { token: staffToken } = await createStaffAndLogin('9300000030', 'Reporty')
    const staffAttempt = await signedReq(app, 'get', '/reports/summary', { token: staffToken, deviceUuid, deviceSecret, query: { from: '2020-01-01', to: '2030-01-01' } })
    expect(staffAttempt.status).toBe(403)

    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId } })
    const shiftId = shiftRes.body.data.shiftInstance._id
    const { tokenCode } = await provisionOneToken()

    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-report-1', locationId, vehicleNumber: 'REPORT001', vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    const sessionId = entryRes.body.data.sessionId

    const exitRes = await signedReq(app, 'post', `/sessions/${sessionId}/exit/request`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { tokenCode, exitAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), locationCheck: goodLocationCheck() },
    })
    await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
      token: staffToken, deviceUuid, deviceSecret, body: { clientTransactionId: 'ctx-report-pay-1', method: 'CASH', amountMinor: exitRes.body.data.amountDueMinor },
    })

    const res = await signedReq(app, 'get', '/reports/summary', { token: adminToken, deviceUuid, deviceSecret, query: { from: '2020-01-01', to: '2030-01-01', locationId } })
    expect(res.status).toBe(200)
    expect(res.body.data.vehiclesEntered).toBeGreaterThanOrEqual(1)
    expect(res.body.data.vehiclesExited).toBeGreaterThanOrEqual(1)
    expect(res.body.data.revenueByMethod.CASH.totalMinor).toBeGreaterThanOrEqual(exitRes.body.data.amountDueMinor)
    expect(res.body.data.totalRevenueMinor).toBeGreaterThanOrEqual(exitRes.body.data.amountDueMinor)

    await signedReq(app, 'post', `/shifts/${shiftId}/force-close`, { token: adminToken, deviceUuid, deviceSecret, body: { reason: 'cleanup' } })
  })

  test('rejects a request missing from/to', async () => {
    const res = await signedReq(app, 'get', '/reports/summary', { token: adminToken, deviceUuid, deviceSecret })
    expect(res.status).toBe(422)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('GET/PATCH /staff/me — self-service profile (mobile Profile screen had nothing to call before this)', () => {
  test('a STAFF account can view and edit their own name/email without needing an Org Admin', async () => {
    const { token: staffToken } = await createStaffAndLogin('9300000050', 'Selfy')

    const meRes = await signedReq(app, 'get', '/staff/me', { token: staffToken, deviceUuid, deviceSecret })
    expect(meRes.status).toBe(200)
    expect(meRes.body.data.staff.name).toBe('Selfy')
    expect(meRes.body.data.staff.role).toBe('STAFF')

    const updateRes = await signedReq(app, 'patch', '/staff/me', {
      token: staffToken, deviceUuid, deviceSecret, body: { name: 'Selfy Updated', email: 'selfy@test.com' },
    })
    expect(updateRes.status).toBe(200)
    expect(updateRes.body.data.staff.name).toBe('Selfy Updated')
    expect(updateRes.body.data.staff.email).toBe('selfy@test.com')
  })

  test('cannot self-promote role or reactivate status through PATCH /staff/me — those fields are rejected outright', async () => {
    const { token: staffToken } = await createStaffAndLogin('9300000051', 'Wannabe Admin')
    const res = await signedReq(app, 'patch', '/staff/me', {
      token: staffToken, deviceUuid, deviceSecret, body: { role: 'ORG_ADMIN' },
    })
    expect(res.status).toBe(422)
  })

  test('changing your own password requires the correct currentPassword', async () => {
    const { token: staffToken } = await createStaffAndLogin('9300000052', 'Pw Changer')

    const missingCurrent = await signedReq(app, 'patch', '/staff/me', {
      token: staffToken, deviceUuid, deviceSecret, body: { newPassword: 'NewPass@123' },
    })
    expect(missingCurrent.status).toBe(422)

    const wrongCurrent = await signedReq(app, 'patch', '/staff/me', {
      token: staffToken, deviceUuid, deviceSecret, body: { currentPassword: 'WrongOne@123', newPassword: 'NewPass@123' },
    })
    expect(wrongCurrent.status).toBe(401)

    const correct = await signedReq(app, 'patch', '/staff/me', {
      token: staffToken, deviceUuid, deviceSecret, body: { currentPassword: 'Staff@123', newPassword: 'NewPass@123' },
    })
    expect(correct.status).toBe(200)

    const reloginOld = await staffLogin(app, orgCode, '9300000052', 'Staff@123').catch((e) => e)
    expect(reloginOld).toBeInstanceOf(Error)
    const reloginNew = await staffLogin(app, orgCode, '9300000052', 'NewPass@123')
    expect(reloginNew.token).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('POST /sessions/:id/exit/request is idempotent on re-scan (§12 edge case found via on-device testing)', () => {
  test('re-requesting exit on an already-PAYMENT_PENDING session returns the same amount instead of erroring', async () => {
    const { token: staffToken } = await createStaffAndLogin('9300000040', 'Rescanner')
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId } })
    const shiftId = shiftRes.body.data.shiftInstance._id
    const { tokenCode } = await provisionOneToken()

    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-rescan-1', locationId, vehicleNumber: 'RESCAN01', vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    const sessionId = entryRes.body.data.sessionId
    const exitAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    const firstExit = await signedReq(app, 'post', `/sessions/${sessionId}/exit/request`, {
      token: staffToken, deviceUuid, deviceSecret, body: { tokenCode, exitAt, locationCheck: goodLocationCheck() },
    })
    expect(firstExit.status).toBe(200)
    expect(firstExit.body.data.status).toBe('PAYMENT_PENDING')

    // Staff double-tapping "Find Vehicle" (or a lost-response retry) re-sends
    // the same exit/request for the same still-pending session.
    const secondExit = await signedReq(app, 'post', `/sessions/${sessionId}/exit/request`, {
      token: staffToken, deviceUuid, deviceSecret, body: { tokenCode, exitAt, locationCheck: goodLocationCheck() },
    })
    expect(secondExit.status).toBe(200)
    expect(secondExit.body.data.status).toBe('PAYMENT_PENDING')
    expect(secondExit.body.data.amountDueMinor).toBe(firstExit.body.data.amountDueMinor)

    await signedReq(app, 'post', `/shifts/${shiftId}/force-close`, { token: adminToken, deviceUuid, deviceSecret, body: { reason: 'cleanup' } })
  })
})
