/**
 * Phase 4 exit criteria (docs/ARCHITECTURE.md §Z): "Two-shift handover
 * integration test (§V) passes; force-close/abandoned path tested."
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
const orgCode = 'shift-co'
const GOOD_GEO = { lat: 12.9716, lng: 77.5946 }
const goodLocationCheck = () => ({ lat: GOOD_GEO.lat, lng: GOOD_GEO.lng, accuracyM: 10, mockDetected: false })

let adminToken, deviceUuid, deviceSecret, locationId, vehicleTypeId, orgId

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
  deviceUuid = 'shift-device-1'
  deviceSecret = await registerDevice(app, adminToken, deviceUuid)

  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: 'Handover Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR' },
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
describe('GET /shifts/current (§7 mobile app support)', () => {
  test('returns null when the caller has no open shift, then the shift once one is started', async () => {
    const { token } = await createStaffAndLogin('9050000001', 'Current Cami')

    const before = await signedReq(app, 'get', '/shifts/current', { token, deviceUuid, deviceSecret })
    expect(before.status).toBe(200)
    expect(before.body.data.shiftInstance).toBeNull()

    const startRes = await signedReq(app, 'post', '/shifts/start', { token, deviceUuid, deviceSecret, body: { locationId } })
    const after = await signedReq(app, 'get', '/shifts/current', { token, deviceUuid, deviceSecret })
    expect(after.body.data.shiftInstance._id).toBe(startRes.body.data.shiftInstance._id)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('two-shift handover with active-vehicle carry-forward (§17-§18)', () => {
  let morningToken, morningShiftId, eveningToken, eveningShiftId
  let carriedSessionId, carriedTokenCode

  test('morning shift: starts, parks a vehicle, closes clean (no cash collected yet under PAY_ON_EXIT)', async () => {
    ;({ token: morningToken } = await createStaffAndLogin('9100000001', 'Morning Mia'))

    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: morningToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
    expect(shiftRes.status).toBe(201)
    morningShiftId = shiftRes.body.data.shiftInstance._id

    carriedTokenCode = await provisionOneToken()
    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: morningToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-carry-1', locationId, vehicleNumber: 'CARRY0001', vehicleTypeId, tokenCode: carriedTokenCode, locationCheck: goodLocationCheck() },
    })
    expect(entryRes.status).toBe(201)
    expect(entryRes.body.data.status).toBe('ACTIVE')
    carriedSessionId = entryRes.body.data.sessionId

    const closeRes = await signedReq(app, 'post', `/shifts/${morningShiftId}/close`, {
      token: morningToken, deviceUuid, deviceSecret, body: { actualCashMinor: 0 },
    })
    expect(closeRes.status).toBe(200)
    expect(closeRes.body.data.status).toBe('CLOSED')
    expect(closeRes.body.data.entriesCount).toBe(1)
    expect(closeRes.body.data.exitsCount).toBe(0)
    expect(closeRes.body.data.requiresApproval).toBe(false)
  })

  test('a different staff member cannot close someone else\'s shift', async () => {
    const { token: rando } = await createStaffAndLogin('9100000099', 'Rando')
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: rando, deviceUuid, deviceSecret, body: { locationId } })
    const randoShiftId = shiftRes.body.data.shiftInstance._id

    const res = await signedReq(app, 'post', `/shifts/${morningShiftId}/close`, { token: rando, deviceUuid, deviceSecret, body: { actualCashMinor: 0 } })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN_ROLE')

    // cleanup: force-close so it doesn't collide with later "one open shift" assumptions elsewhere
    await signedReq(app, 'post', `/shifts/${randoShiftId}/force-close`, { token: adminToken, deviceUuid, deviceSecret, body: { reason: 'test cleanup' } })
  })

  test('handover cannot be initiated before the outgoing shift is closed', async () => {
    const { token: notYetClosedToken } = await createStaffAndLogin('9100000098', 'NotClosed')
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: notYetClosedToken, deviceUuid, deviceSecret, body: { locationId } })
    const openShiftId = shiftRes.body.data.shiftInstance._id

    const otherShiftRes = await signedReq(app, 'post', '/shifts/start', { token: (await createStaffAndLogin('9100000097', 'Other')).token, deviceUuid, deviceSecret, body: { locationId } })

    const res = await signedReq(app, 'post', `/shifts/${openShiftId}/handover/initiate`, {
      token: notYetClosedToken, deviceUuid, deviceSecret, body: { toShiftInstanceId: otherShiftRes.body.data.shiftInstance._id },
    })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('SHIFT_INVALID_TRANSITION')

    await signedReq(app, 'post', `/shifts/${openShiftId}/force-close`, { token: adminToken, deviceUuid, deviceSecret, body: { reason: 'test cleanup' } })
  })

  test('evening staff starts their own shift at the same location', async () => {
    ;({ token: eveningToken } = await createStaffAndLogin('9100000002', 'Evening Eve'))
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: eveningToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
    expect(shiftRes.status).toBe(201)
    eveningShiftId = shiftRes.body.data.shiftInstance._id
  })

  test('handover initiate snapshots the active vehicle + token inventory (§17)', async () => {
    const res = await signedReq(app, 'post', `/shifts/${morningShiftId}/handover/initiate`, {
      token: morningToken, deviceUuid, deviceSecret, body: { toShiftInstanceId: eveningShiftId },
    })
    expect(res.status).toBe(201)
    expect(res.body.data.handover.activeVehicleCount).toBe(1) // the still-parked CARRY0001
    expect(res.body.data.handover.tokenSummary.ACTIVE).toBe(1)
    expect(res.body.data.handover.status).toBe('PENDING')
  })

  test('only the incoming staff member can accept the handover', async () => {
    const handoverDoc = await require('../models/ShiftHandover').findOne({ organizationId: orgId, fromShiftInstanceId: morningShiftId })
    const handoverId = handoverDoc._id.toString()

    const wrongPersonRes = await signedReq(app, 'post', `/handovers/${handoverId}/accept`, { token: morningToken, deviceUuid, deviceSecret })
    expect(wrongPersonRes.status).toBe(403)
    expect(wrongPersonRes.body.code).toBe('FORBIDDEN_ROLE')

    const res = await signedReq(app, 'post', `/handovers/${handoverId}/accept`, { token: eveningToken, deviceUuid, deviceSecret })
    expect(res.status).toBe(200)
    expect(res.body.data.handover.status).toBe('ACCEPTED')
  })

  test('the outgoing shift is now HANDED_OVER (§H terminal state)', async () => {
    const ShiftInstance = require('../models/ShiftInstance')
    const shift = await ShiftInstance.findOne({ organizationId: orgId, _id: morningShiftId })
    expect(shift.status).toBe('HANDED_OVER')
  })

  test('the carried-forward vehicle is NOT a new entry — evening staff exits it using the SAME session, with THEIR shift as the exit shift', async () => {
    const exitAt = new Date(Date.now() + 60 * 60 * 1000)
    const exitRes = await signedReq(app, 'post', `/sessions/${carriedSessionId}/exit/request`, {
      token: eveningToken, deviceUuid, deviceSecret,
      body: { tokenCode: carriedTokenCode, exitAt: exitAt.toISOString(), locationCheck: goodLocationCheck() },
    })
    expect(exitRes.status).toBe(200)
    expect(exitRes.body.data.status).toBe('PAYMENT_PENDING')

    const ParkingSession = require('../models/ParkingSession')
    const session = await ParkingSession.findOne({ organizationId: orgId, _id: carriedSessionId })
    expect(String(session.entryShiftInstanceId)).toBe(String(morningShiftId)) // history preserved
    expect(String(session.exitShiftInstanceId)).toBe(String(eveningShiftId)) // exit attributed correctly

    const payRes = await signedReq(app, 'post', `/sessions/${carriedSessionId}/payment`, {
      token: eveningToken, deviceUuid, deviceSecret, body: { clientTransactionId: 'ctx-carry-pay-1', method: 'CASH', amountMinor: exitRes.body.data.amountDueMinor },
    })
    expect(payRes.status).toBe(201)
    expect(payRes.body.data.sessionStatus).toBe('COMPLETED')
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('cash mismatch requiring Manager approval (§15)', () => {
  test('a variance past the threshold leaves the tally unapproved, and Staff cannot approve it themselves', async () => {
    const { token: staffToken } = await createStaffAndLogin('9200000001', 'Mismatch Mo')
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
    const shiftId = shiftRes.body.data.shiftInstance._id

    const tokenCode = await provisionOneToken()
    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-mismatch-1', locationId, vehicleNumber: 'MISMATCH1', vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    const sessionId = entryRes.body.data.sessionId

    // 5 hours -> firstHour(3000) + 4*additional(2000) = 11000, deliberately
    // above the ₹100/10000-minor-unit approval threshold (a 1hr/3000 stay
    // would NOT trigger approval — that's correct, not a bug, so the test
    // needs a big enough variance to actually exercise the threshold).
    const exitRes = await signedReq(app, 'post', `/sessions/${sessionId}/exit/request`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { tokenCode, exitAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(), locationCheck: goodLocationCheck() },
    })
    const amountDue = exitRes.body.data.amountDueMinor // 11000

    await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
      token: staffToken, deviceUuid, deviceSecret, body: { clientTransactionId: 'ctx-mismatch-pay-1', method: 'CASH', amountMinor: amountDue },
    })

    // staff reports way less cash than expected (short by more than the ₹100 threshold)
    const closeRes = await signedReq(app, 'post', `/shifts/${shiftId}/close`, {
      token: staffToken, deviceUuid, deviceSecret, body: { actualCashMinor: 0, notes: 'cash drawer came up short' },
    })
    expect(closeRes.status).toBe(200)
    expect(closeRes.body.data.varianceMinor).toBe(0 - amountDue)
    expect(closeRes.body.data.requiresApproval).toBe(true)

    const staffApproveRes = await signedReq(app, 'post', `/shifts/${shiftId}/tally/approve`, { token: staffToken, deviceUuid, deviceSecret })
    expect(staffApproveRes.status).toBe(403)

    const managerApproveRes = await signedReq(app, 'post', `/shifts/${shiftId}/tally/approve`, { token: adminToken, deviceUuid, deviceSecret })
    expect(managerApproveRes.status).toBe(200)
    expect(managerApproveRes.body.data.tally.approvedBy).toBeTruthy()

    const doubleApproveRes = await signedReq(app, 'post', `/shifts/${shiftId}/tally/approve`, { token: adminToken, deviceUuid, deviceSecret })
    expect(doubleApproveRes.status).toBe(409)
  })

  test('closing without a reason when there IS a variance is rejected', async () => {
    const { token: staffToken } = await createStaffAndLogin('9200000002', 'No Reason Nora')
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
    const shiftId = shiftRes.body.data.shiftInstance._id

    const res = await signedReq(app, 'post', `/shifts/${shiftId}/close`, { token: staffToken, deviceUuid, deviceSecret, body: { actualCashMinor: 500 } })
    expect(res.status).toBe(422)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('force-close / abandoned path (§14, §H)', () => {
  test('a shift left open is force-closed by a Manager+, creating an Incident', async () => {
    const { token: staffToken } = await createStaffAndLogin('9300000001', 'Abandoned Abe')
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId } })
    const shiftId = shiftRes.body.data.shiftInstance._id

    const staffAttempt = await signedReq(app, 'post', `/shifts/${shiftId}/force-close`, { token: staffToken, deviceUuid, deviceSecret, body: { reason: 'trying to self-abandon' } })
    expect(staffAttempt.status).toBe(403) // §14: only Manager+ can force-close

    const res = await signedReq(app, 'post', `/shifts/${shiftId}/force-close`, {
      token: adminToken, deviceUuid, deviceSecret, body: { reason: 'device lost, staff unreachable' },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.shiftInstance.status).toBe('ABANDONED')
    expect(res.body.data.incidentId).toBeTruthy()

    const Incident = require('../models/Incident')
    const incident = await Incident.findById(res.body.data.incidentId)
    expect(incident.type).toBe('SHIFT_ABANDONED')
    expect(incident.severity).toBe('HIGH')
  })

  test('force-closing without a reason is rejected', async () => {
    const { token: staffToken } = await createStaffAndLogin('9300000002', 'No Reason Ned')
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId } })
    const shiftId = shiftRes.body.data.shiftInstance._id

    const res = await signedReq(app, 'post', `/shifts/${shiftId}/force-close`, { token: adminToken, deviceUuid, deviceSecret, body: {} })
    expect(res.status).toBe(422)
  })

  test('ABANDONED is terminal — cannot be closed normally afterward', async () => {
    const { token: staffToken } = await createStaffAndLogin('9300000003', 'Terminal Terry')
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId } })
    const shiftId = shiftRes.body.data.shiftInstance._id
    await signedReq(app, 'post', `/shifts/${shiftId}/force-close`, { token: adminToken, deviceUuid, deviceSecret, body: { reason: 'test' } })

    const res = await signedReq(app, 'post', `/shifts/${shiftId}/close`, { token: staffToken, deviceUuid, deviceSecret, body: { actualCashMinor: 0 } })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('SHIFT_ALREADY_CLOSED')
  })
})
