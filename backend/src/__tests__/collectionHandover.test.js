/**
 * CollectionHandover — a STAFF member depositing collected cash TO an
 * Admin/Manager, tracked PENDING -> CONFIRMED/REJECTED. Deliberately
 * separate from ShiftHandover (phase4.shiftAndHandover.test.js's
 * staff-to-staff continuity flow) — this never touches ShiftInstance.status.
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
const orgCode = 'collection-co'
const GOOD_GEO = { lat: 12.9716, lng: 77.5946 }

let adminToken, deviceUuid, deviceSecret, locationId, orgId

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
  const onboarded = await onboardOrg(app, { platformToken, code: orgCode, countryId, adminPhone: '9500000001' })
  orgId = onboarded.organization._id
  ;({ token: adminToken } = await staffLogin(app, orgCode, '9500000001', 'Admin@123'))
  deviceUuid = 'collection-device-1'
  deviceSecret = await registerDevice(app, adminToken, deviceUuid)

  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: 'Collection Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR' },
  })
  locationId = locRes.body.data.location._id
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

async function createStaffAndLogin(phone, name = 'Staffer') {
  await signedReq(app, 'post', '/staff', { token: adminToken, deviceUuid, deviceSecret, body: { name, phone, password: 'Staff@123', role: 'STAFF' } })
  return staffLogin(app, orgCode, phone, 'Staff@123')
}

async function startAndCloseShift(token, actualCashMinor = 5000) {
  const startRes = await signedReq(app, 'post', '/shifts/start', { token, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
  const shiftId = startRes.body.data.shiftInstance._id
  // Nothing was actually collected in these test shifts (no sessions/payments), so
  // expectedCashMinor is 0 — any nonzero actualCashMinor is a "mismatch" requiring notes.
  const closeRes = await signedReq(app, 'post', `/shifts/${shiftId}/close`, { token, deviceUuid, deviceSecret, body: { actualCashMinor, notes: 'test cash count' } })
  if (closeRes.status !== 200) throw new Error(`shift close failed: ${closeRes.status} ${JSON.stringify(closeRes.body)}`)
  return shiftId
}

// ═══════════════════════════════════════════════════════════════════════
describe('collection handover cannot be initiated before the shift is tallied', () => {
  test('an OPEN shift is rejected with SHIFT_INVALID_TRANSITION', async () => {
    const { token } = await createStaffAndLogin('9600000001', 'Not Yet Closed')
    const startRes = await signedReq(app, 'post', '/shifts/start', { token, deviceUuid, deviceSecret, body: { locationId } })
    const shiftId = startRes.body.data.shiftInstance._id

    const res = await signedReq(app, 'post', '/collection-handovers', {
      token, deviceUuid, deviceSecret, body: { shiftInstanceId: shiftId, amountMinor: 1000 },
    })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('SHIFT_INVALID_TRANSITION')

    await signedReq(app, 'post', `/shifts/${shiftId}/force-close`, { token: adminToken, deviceUuid, deviceSecret, body: { reason: 'test cleanup' } })
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('ownership: only the shift\'s own staff member (or Manager+) can initiate', () => {
  test('a different staff member is forbidden', async () => {
    const { token: ownerToken } = await createStaffAndLogin('9600000002', 'Owner Olu')
    const shiftId = await startAndCloseShift(ownerToken, 5000)

    const { token: randoToken } = await createStaffAndLogin('9600000003', 'Rando')
    const res = await signedReq(app, 'post', '/collection-handovers', {
      token: randoToken, deviceUuid, deviceSecret, body: { shiftInstanceId: shiftId, amountMinor: 5000 },
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN_ROLE')
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('full flow: initiate -> confirm with a variance', () => {
  let staffToken, staffUserId, shiftId, handoverId

  test('staff initiates a claim for the cash they counted at close', async () => {
    const login = await createStaffAndLogin('9600000004', 'Depositing Dara')
    staffToken = login.token
    staffUserId = login.staffUser.id
    shiftId = await startAndCloseShift(staffToken, 8000)

    const res = await signedReq(app, 'post', '/collection-handovers', {
      token: staffToken, deviceUuid, deviceSecret, body: { shiftInstanceId: shiftId, amountMinor: 8000, notes: 'handed to front desk' },
    })
    expect(res.status).toBe(201)
    expect(res.body.data.collectionHandover.status).toBe('PENDING')
    expect(res.body.data.collectionHandover.amountMinor).toBe(8000)
    handoverId = res.body.data.collectionHandover._id
  })

  test('a second PENDING claim for the same shift is rejected as a duplicate', async () => {
    const res = await signedReq(app, 'post', '/collection-handovers', {
      token: staffToken, deviceUuid, deviceSecret, body: { shiftInstanceId: shiftId, amountMinor: 8000 },
    })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('COLLECTION_HANDOVER_ALREADY_PENDING')
  })

  test('staff cannot confirm their own handover', async () => {
    const res = await signedReq(app, 'post', `/collection-handovers/${handoverId}/confirm`, {
      token: staffToken, deviceUuid, deviceSecret, body: { receivedAmountMinor: 8000 },
    })
    expect(res.status).toBe(403)
  })

  test('Admin confirms, recording the actual amount received and any variance', async () => {
    const res = await signedReq(app, 'post', `/collection-handovers/${handoverId}/confirm`, {
      token: adminToken, deviceUuid, deviceSecret, body: { receivedAmountMinor: 7800, notes: 'counted at desk' },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.collectionHandover.status).toBe('CONFIRMED')
    expect(res.body.data.collectionHandover.receivedAmountMinor).toBe(7800)
    expect(res.body.data.collectionHandover.varianceMinor).toBe(-200)
    expect(res.body.data.collectionHandover.confirmedAt).toBeTruthy()
  })

  test('an already-confirmed handover cannot be confirmed again', async () => {
    const res = await signedReq(app, 'post', `/collection-handovers/${handoverId}/confirm`, {
      token: adminToken, deviceUuid, deviceSecret, body: { receivedAmountMinor: 7800 },
    })
    expect(res.status).toBe(409)
  })

  test('staff can now re-initiate a fresh claim for the same shift (the old one is no longer PENDING)', async () => {
    const res = await signedReq(app, 'post', '/collection-handovers', {
      token: staffToken, deviceUuid, deviceSecret, body: { shiftInstanceId: shiftId, amountMinor: 200, notes: 'shortfall follow-up' },
    })
    expect(res.status).toBe(201)
  })

  test('GET /collection-handovers scopes STAFF to their own rows only, Manager+ sees all', async () => {
    const staffList = await signedReq(app, 'get', '/collection-handovers', { token: staffToken, deviceUuid, deviceSecret })
    expect(staffList.status).toBe(200)
    expect(staffList.body.data.collectionHandovers.every((h) => String(h.staffId._id) === String(staffUserId))).toBe(true)

    const adminList = await signedReq(app, 'get', '/collection-handovers', { token: adminToken, deviceUuid, deviceSecret, query: { status: 'PENDING' } })
    expect(adminList.status).toBe(200)
    expect(adminList.body.data.collectionHandovers.every((h) => h.status === 'PENDING')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('reject path', () => {
  test('Admin rejects a claim with a reason; a rejected claim cannot be acted on again', async () => {
    const { token: staffToken } = await createStaffAndLogin('9600000005', 'Rejected Rae')
    const shiftId = await startAndCloseShift(staffToken, 3000)

    const initRes = await signedReq(app, 'post', '/collection-handovers', {
      token: staffToken, deviceUuid, deviceSecret, body: { shiftInstanceId: shiftId, amountMinor: 3000 },
    })
    const handoverId = initRes.body.data.collectionHandover._id

    const noReasonRes = await signedReq(app, 'post', `/collection-handovers/${handoverId}/reject`, {
      token: adminToken, deviceUuid, deviceSecret, body: {},
    })
    expect(noReasonRes.status).toBe(422)

    const res = await signedReq(app, 'post', `/collection-handovers/${handoverId}/reject`, {
      token: adminToken, deviceUuid, deviceSecret, body: { reason: 'wrong amount claimed' },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.collectionHandover.status).toBe('REJECTED')
    expect(res.body.data.collectionHandover.rejectionReason).toBe('wrong amount claimed')

    const doubleRes = await signedReq(app, 'post', `/collection-handovers/${handoverId}/reject`, {
      token: adminToken, deviceUuid, deviceSecret, body: { reason: 'again' },
    })
    expect(doubleRes.status).toBe(409)
  })
})
