/**
 * Covers the new backend surface added for the search/reconciliation/admin-
 * visibility batch: partial multi-field session search (the actual fix for
 * "vehicle search isn't working"), the shift tally-preview endpoint, the
 * staff-collection report, and the on-duty/admin-contacts endpoints. Same
 * black-box, real-replica-set style as phase3.entryExitFlow.test.js.
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
let orgCode = 'search-recon-co'
let adminToken, staffToken
let deviceUuid = 'shared-device-10'
let deviceSecret
let locationId, vehicleTypeId
let shiftInstanceId
let tokenCode, sessionId

const GOOD_GEO = { lat: 12.9716, lng: 77.5946 }
function goodLocationCheck(overrides = {}) {
  return { lat: GOOD_GEO.lat, lng: GOOD_GEO.lng, accuracyM: 10, mockDetected: false, ...overrides }
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner10@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()

  const platformToken = await platformLogin(app, 'owner10@test.com', 'Owner@123')
  await onboardOrg(app, { platformToken, code: orgCode, countryId, adminPhone: '9100000001' })
  ;({ token: adminToken } = await staffLogin(app, orgCode, '9100000001', 'Admin@123'))
  deviceSecret = await registerDevice(app, adminToken, deviceUuid)

  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: 'Recon Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
  })
  locationId = locRes.body.data.location._id

  const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
  vehicleTypeId = vtRes.body.data.vehicleType._id

  await signedReq(app, 'post', '/pricing-rules', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { locationId, vehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Car flat', config: { flatAmountMinor: 5000 } },
  })

  const staffRes = await signedReq(app, 'post', '/staff', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { name: 'Staff Priya', phone: '9100000003', password: 'Staff@123', role: 'STAFF' },
  })
  expect(staffRes.status).toBe(201)
  ;({ token: staffToken } = await staffLogin(app, orgCode, '9100000003', 'Staff@123'))

  const shiftRes = await signedReq(app, 'post', '/shifts/start', {
    token: staffToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 },
  })
  shiftInstanceId = shiftRes.body.data.shiftInstance._id

  const tokenRes = await signedReq(app, 'post', '/tokens/batches', {
    token: adminToken, deviceUuid, deviceSecret, body: { locationId, batchSize: 1 },
  })
  tokenCode = tokenRes.body.data.tokens[0].tokenCode

  const entryRes = await signedReq(app, 'post', '/sessions/entry', {
    token: staffToken, deviceUuid, deviceSecret,
    body: {
      clientTransactionId: 'ctx-recon-entry-1',
      locationId, vehicleNumber: 'tn 45 ab 1234', vehicleTypeId, tokenCode,
      locationCheck: goodLocationCheck(),
    },
  })
  sessionId = entryRes.body.data.sessionId

  await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
    token: staffToken, deviceUuid, deviceSecret,
    body: { clientTransactionId: 'ctx-recon-payment-1', method: 'UPI', amountMinor: 5000 },
  })
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

describe('GET /sessions/search — partial, multi-field (the vehicle-search fix)', () => {
  test('a partial vehicle-number substring finds the session', async () => {
    const res = await signedReq(app, 'get', '/sessions/search', { token: staffToken, deviceUuid, deviceSecret, query: { q: 'AB12' } })
    expect(res.status).toBe(200)
    expect(res.body.data.sessions.some((s) => s._id === sessionId)).toBe(true)
  })

  test('a lowercase partial substring still matches (case-insensitive)', async () => {
    const res = await signedReq(app, 'get', '/sessions/search', { token: staffToken, deviceUuid, deviceSecret, query: { q: 'ab12' } })
    expect(res.status).toBe(200)
    expect(res.body.data.sessions.some((s) => s._id === sessionId)).toBe(true)
  })

  test('the exact old exact-match behavior would have missed this — confirms the fix', async () => {
    const res = await signedReq(app, 'get', '/sessions/search', { token: staffToken, deviceUuid, deviceSecret, query: { q: '1234' } })
    expect(res.status).toBe(200)
    expect(res.body.data.sessions.some((s) => s._id === sessionId)).toBe(true)
  })

  test('a partial QR token code also finds the session', async () => {
    const partial = tokenCode.slice(-4)
    const res = await signedReq(app, 'get', '/sessions/search', { token: staffToken, deviceUuid, deviceSecret, query: { q: partial } })
    expect(res.status).toBe(200)
    expect(res.body.data.sessions.some((s) => s._id === sessionId)).toBe(true)
  })

  test('results carry populated vehicle/token/staff/payment details for the History screen', async () => {
    const res = await signedReq(app, 'get', '/sessions/search', { token: staffToken, deviceUuid, deviceSecret, query: { q: '1234' } })
    const row = res.body.data.sessions.find((s) => s._id === sessionId)
    expect(row.vehicleId.vehicleNumber).toBe('TN45AB1234')
    expect(row.tokenId.tokenCode).toBe(tokenCode)
    expect(row.entryStaffId.name).toBe('Staff Priya')
    expect(row.payments).toEqual([{ method: 'UPI', amountMinor: 5000, status: 'PAID' }])
  })

  test('a query matching nothing returns an empty array, not an error', async () => {
    const res = await signedReq(app, 'get', '/sessions/search', { token: staffToken, deviceUuid, deviceSecret, query: { q: 'ZZZZ-NO-MATCH' } })
    expect(res.status).toBe(200)
    expect(res.body.data.sessions).toEqual([])
  })

  test('a regex-metacharacter query does not 500', async () => {
    const res = await signedReq(app, 'get', '/sessions/search', { token: staffToken, deviceUuid, deviceSecret, query: { q: '((invalid' } })
    expect(res.status).toBe(200)
  })
})

describe('GET /shifts/:id/tally-preview — read-only, pre-close', () => {
  test('shows the expected UPI collection before the shift is closed, and does not persist a tally', async () => {
    const res = await signedReq(app, 'get', `/shifts/${shiftInstanceId}/tally-preview`, { token: staffToken, deviceUuid, deviceSecret })
    expect(res.status).toBe(200)
    expect(res.body.data.preview.expectedUpiMinor).toBe(5000)
    expect(res.body.data.preview.expectedCashMinor).toBe(0)

    const tallyRes = await signedReq(app, 'get', `/shifts/${shiftInstanceId}/tally`, { token: staffToken, deviceUuid, deviceSecret })
    expect(tallyRes.status).toBe(404) // preview must not have created a real ShiftTally
  })

  test('GET /staff/on-duty lists Staff Priya\'s still-open shift with her phone and location', async () => {
    const res = await signedReq(app, 'get', '/staff/on-duty', { token: adminToken, deviceUuid, deviceSecret })
    expect(res.status).toBe(200)
    const row = res.body.data.onDuty.find((d) => d.shiftInstanceId === shiftInstanceId)
    expect(row).toBeDefined()
    expect(row.staffName).toBe('Staff Priya')
    expect(row.staffPhone).toBe('9100000003')
    expect(row.locationName).toBe('Recon Lot')
  })
})

describe('shift close + staff-collection / admin-reconciliation report', () => {
  test('closing the shift with matching cash (0, since this session was paid by UPI) succeeds without a reason', async () => {
    const res = await signedReq(app, 'post', `/shifts/${shiftInstanceId}/close`, {
      token: staffToken, deviceUuid, deviceSecret, body: { actualCashMinor: 0 },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.expectedUpiMinor).toBe(5000)
  })

  test('GET /reports/staff-collection shows the closed shift, per-shift and summed per staff', async () => {
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const res = await signedReq(app, 'get', '/reports/staff-collection', { token: adminToken, deviceUuid, deviceSecret, query: { from, to } })
    expect(res.status).toBe(200)

    const shiftRow = res.body.data.shifts.find((s) => s.shiftInstanceId === shiftInstanceId)
    expect(shiftRow).toBeDefined()
    expect(shiftRow.staffName).toBe('Staff Priya')
    expect(shiftRow.expectedUpiMinor).toBe(5000)
    expect(shiftRow.varianceMinor).toBe(0)

    const staffRow = res.body.data.byStaff.find((s) => s.staffName === 'Staff Priya')
    expect(staffRow.shiftsCount).toBe(1)
    expect(staffRow.expectedUpiMinor).toBe(5000)
  })

  test('a plain STAFF cannot read the staff-collection report (Manager+ only, same tier as /reports/summary)', async () => {
    const res = await signedReq(app, 'get', '/reports/staff-collection', {
      token: staffToken, deviceUuid, deviceSecret, query: { from: '2020-01-01', to: '2030-01-01' },
    })
    expect(res.status).toBe(403)
  })
})

describe('staff duty & admin contacts', () => {
  test('GET /staff/admin-contacts returns the org admin\'s phone, reachable by a plain staff account', async () => {
    const res = await signedReq(app, 'get', '/staff/admin-contacts', { token: staffToken, deviceUuid, deviceSecret })
    expect(res.status).toBe(200)
    expect(res.body.data.admins.some((a) => a.phone === '9100000001')).toBe(true)
  })

  test('GET /staff/on-duty no longer lists Staff Priya once her shift is closed (it was closed above)', async () => {
    const res = await signedReq(app, 'get', '/staff/on-duty', { token: adminToken, deviceUuid, deviceSecret })
    expect(res.status).toBe(200)
    expect(res.body.data.onDuty.some((d) => d.shiftInstanceId === shiftInstanceId)).toBe(false)
  })
})
