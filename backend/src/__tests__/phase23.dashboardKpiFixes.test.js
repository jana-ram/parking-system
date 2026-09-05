/**
 * Coverage for the Dashboard KPI accuracy pass (found by a full-app
 * "verify every KPI matches actual data" audit): report.controller.js's
 * getSummary previously computed "Vehicles Exited" off entryAt instead of
 * exitAt, excluded PARTIALLY_PAID parking payments from revenue while
 * Staff Collection's tally already included them, had no status filter at
 * all on Luggage/Parcel revenue, and counted "Active" Luggage/Parcel orders
 * as a date-range-scoped snapshot instead of a live one (unlike
 * "Currently Parked" and overdueCount). Plus: "Currently Parked" and
 * "Open Alerts" read `.length` of a `.limit(200)`-capped list instead of a
 * real count.
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
let platformToken

const GOOD_GEO = { lat: 12.9716, lng: 77.5946 }
function goodLocationCheck(overrides = {}) {
  return { lat: GOOD_GEO.lat, lng: GOOD_GEO.lng, accuracyM: 10, mockDetected: false, ...overrides }
}

async function enableModules(orgId, modules) {
  const res = await request(app).patch(`/platform/organizations/${orgId}/modules`).set('Authorization', `Bearer ${platformToken}`).send(modules)
  expect(res.status).toBe(200)
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner23@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner23@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

async function setUpParkingOrg(code, adminPhone) {
  await onboardOrg(app, { platformToken, code, countryId, adminPhone })
  const { token: adminToken } = await staffLogin(app, code, adminPhone, 'Admin@123')
  const deviceUuid = `device-${code}`
  const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: `${code} Lot`, geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
  })
  const locationId = locRes.body.data.location._id
  const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
  const vehicleTypeId = vtRes.body.data.vehicleType._id
  await signedReq(app, 'post', '/pricing-rules', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { locationId, vehicleTypeId, mode: 'PAY_ON_EXIT', name: 'Hourly', config: { tierType: 'HOURLY', firstHourMinor: 2000, additionalHourMinor: 1000 } },
  })
  await signedReq(app, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })

  return { adminToken, deviceUuid, deviceSecret, locationId, vehicleTypeId }
}

describe('C0: "Vehicles Exited" now keys off exitAt, not entryAt', () => {
  test('a vehicle that entered days ago and exits today counts as exited today, not on the day it entered', async () => {
    const ctx = await setUpParkingOrg('kpi-exit', '9900000001')
    const tokenRes = await signedReq(app, 'post', '/tokens/batches', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { locationId: ctx.locationId, batchSize: 1 } })
    const tokenCode = tokenRes.body.data.tokens[0].tokenCode

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { clientTransactionId: 'ctx-kpi-exit-entry', locationId: ctx.locationId, vehicleNumber: 'KA05EX0001', vehicleTypeId: ctx.vehicleTypeId, tokenCode, entryAt: threeDaysAgo.toISOString(), locationCheck: goodLocationCheck() },
    })
    expect(entryRes.status).toBe(201)
    const sessionId = entryRes.body.data.sessionId

    const now = new Date()
    const exitRes = await signedReq(app, 'post', `/sessions/${sessionId}/exit/request`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { tokenCode, exitAt: now.toISOString(), locationCheck: goodLocationCheck() },
    })
    expect(exitRes.status).toBe(200)
    const amountDueMinor = exitRes.body.data.amountDueMinor

    const payRes = await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { clientTransactionId: 'ctx-kpi-exit-pay', method: 'CASH', amountMinor: amountDueMinor },
    })
    expect(payRes.body.data.sessionStatus).toBe('COMPLETED')

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const summaryRes = await signedReq(app, 'get', '/reports/summary', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      query: { from: todayStart.toISOString(), to: new Date(now.getTime() + 60000).toISOString() },
    })
    expect(summaryRes.status).toBe(200)
    // Entered 3 days ago — outside today's range.
    expect(summaryRes.body.data.vehiclesEntered).toBe(0)
    // Exited (exitAt) today — must be counted today, not on entry day.
    expect(summaryRes.body.data.vehiclesExited).toBe(1)
    expect(summaryRes.body.data.byModule.parking.vehiclesExited).toBe(1)
  });
});

describe('C1: parking revenue now includes PARTIALLY_PAID payments', () => {
  test('a partial cash payment on a session counts toward Total Revenue', async () => {
    const ctx = await setUpParkingOrg('kpi-partial', '9900000002')
    const tokenRes = await signedReq(app, 'post', '/tokens/batches', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { locationId: ctx.locationId, batchSize: 1 } })
    const tokenCode = tokenRes.body.data.tokens[0].tokenCode

    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { clientTransactionId: 'ctx-kpi-partial-entry', locationId: ctx.locationId, vehicleNumber: 'KA05PP0001', vehicleTypeId: ctx.vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    const sessionId = entryRes.body.data.sessionId

    const exitRes = await signedReq(app, 'post', `/sessions/${sessionId}/exit/request`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { tokenCode, exitAt: new Date().toISOString(), locationCheck: goodLocationCheck() },
    })
    const amountDueMinor = exitRes.body.data.amountDueMinor
    expect(amountDueMinor).toBeGreaterThan(0)
    const partialAmount = Math.max(1, Math.floor(amountDueMinor / 2))

    const payRes = await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { clientTransactionId: 'ctx-kpi-partial-pay', method: 'CASH', amountMinor: partialAmount },
    })
    expect(payRes.body.data.status).toBe('PARTIALLY_PAID')

    const from = new Date(Date.now() - 60000).toISOString()
    const to = new Date(Date.now() + 60000).toISOString()
    const summaryRes = await signedReq(app, 'get', '/reports/summary', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, query: { from, to } })
    expect(summaryRes.body.data.totalRevenueMinor).toBe(partialAmount)
    expect(summaryRes.body.data.byModule.parking.revenueMinor).toBe(partialAmount)
    expect(summaryRes.body.data.revenueByMethod.CASH.totalMinor).toBe(partialAmount)
  });
});

describe('C2: Luggage "Active" orders are a live snapshot, not date-range-scoped', () => {
  test('an active order created before the report window still counts as active', async () => {
    const code = 'kpi-luggage-live'
    const org = await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9900000003' })
    await enableModules(org.organization._id, { LUGGAGE: true })
    const { token: adminToken } = await staffLogin(app, code, '9900000003', 'Admin@123')
    const deviceUuid = `device-${code}`
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)
    const locRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: `${code} Lot`, geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
    })
    const locationId = locRes.body.data.location._id
    await signedReq(app, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })

    const orderRes = await signedReq(app, 'post', '/luggage-orders', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { locationId, customerName: 'Live Snapshot', customerPhone: '9999999996', ratePerDayMinor: 5000 },
    })
    expect(orderRes.status).toBe(201)

    // A report window entirely AFTER the order's createdAt (tomorrow ->
    // day-after) — under the old createdAt-scoped bug this order would be
    // invisible; it must still show up as ACTIVE since that's a live count.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const dayAfter = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
    const summaryRes = await signedReq(app, 'get', '/reports/summary', { token: adminToken, deviceUuid, deviceSecret, query: { from: tomorrow, to: dayAfter } })
    expect(summaryRes.status).toBe(200)
    expect(summaryRes.body.data.byModule.luggage.orders.ACTIVE).toBeGreaterThanOrEqual(1)
  });
});

describe('C3: "Currently Parked" and "Open Alerts" expose a real count, not a capped list length', () => {
  test('GET /sessions/active returns an accurate count alongside the (capped) list', async () => {
    const ctx = await setUpParkingOrg('kpi-count', '9900000004')
    const tokenRes = await signedReq(app, 'post', '/tokens/batches', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { locationId: ctx.locationId, batchSize: 1 } })
    const tokenCode = tokenRes.body.data.tokens[0].tokenCode
    await signedReq(app, 'post', '/sessions/entry', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { clientTransactionId: 'ctx-kpi-count-entry', locationId: ctx.locationId, vehicleNumber: 'KA05CT0001', vehicleTypeId: ctx.vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })

    const activeRes = await signedReq(app, 'get', '/sessions/active', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret })
    expect(activeRes.status).toBe(200)
    expect(activeRes.body.data.count).toBe(1)
    expect(activeRes.body.data.count).toBe(activeRes.body.data.sessions.length)
  });

  test('GET /incidents returns an accurate count alongside the (capped) list', async () => {
    const code = 'kpi-incident-count'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9900000005' })
    const { token: adminToken } = await staffLogin(app, code, '9900000005', 'Admin@123')
    const deviceUuid = `device-${code}`
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const res = await signedReq(app, 'get', '/incidents', { token: adminToken, deviceUuid, deviceSecret, query: { status: 'OPEN' } })
    expect(res.status).toBe(200)
    expect(res.body.data.count).toBe(res.body.data.incidents.length)
  });
});
