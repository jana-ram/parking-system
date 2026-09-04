/**
 * Coverage for the cross-module reconciliation fix: shift.service.js's
 * computeTally() previously only summed Parking Payment records, silently
 * excluding cash/UPI/card collected for Luggage/Parcel orders during the
 * same shift — a real revenue-leakage blind spot (see that file's updated
 * header comment). This suite proves the shift close tally now folds those
 * in, the per-shift transaction drill-down lists them, and both new CSV
 * exports (shift transactions, corrections) work.
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
  await PlatformAdmin.create({ name: 'Owner', email: 'owner22@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner22@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

async function setUpOrgWithLuggage(code, adminPhone) {
  const org = await onboardOrg(app, { platformToken, code, countryId, adminPhone })
  await enableModules(org.organization._id, { LUGGAGE: true, PARCEL: true })
  const { token: adminToken } = await staffLogin(app, code, adminPhone, 'Admin@123')
  const deviceUuid = `device-${code}`
  const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: `${code} Lot`, geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
  })
  const locationId = locRes.body.data.location._id

  const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
  const shiftInstanceId = shiftRes.body.data.shiftInstance._id

  return { adminToken, deviceUuid, deviceSecret, locationId, shiftInstanceId }
}

describe('C0: shift cash tally folds in Luggage/Parcel cash collected the same shift', () => {
  test('a cash luggage payment counts toward expectedCashMinor at shift close', async () => {
    const ctx = await setUpOrgWithLuggage('xmod-tally', '9600000001')

    const orderRes = await signedReq(app, 'post', '/luggage-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, customerName: 'Cash Payer', customerPhone: '9999999991', ratePerDayMinor: 5000 },
    })
    const orderId = orderRes.body.data.order._id
    await signedReq(app, 'post', `/luggage-orders/${orderId}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { method: 'CASH', amountMinor: 3000, clientTransactionId: 'ctx-xmod-lug-pay-1' },
    })

    const closeRes = await signedReq(app, 'post', `/shifts/${ctx.shiftInstanceId}/close`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { actualCashMinor: 3000 },
    })
    expect(closeRes.status).toBe(200)
    // Before the fix this was 0 (Luggage cash was invisible to the tally),
    // which would have raised a false ₹30 "surplus" variance here instead.
    expect(closeRes.body.data.expectedCashMinor).toBe(3000)
    expect(closeRes.body.data.varianceMinor).toBe(0)
  });

  test('a UPI parcel payment counts toward expectedUpiMinor, not cash', async () => {
    const ctx = await setUpOrgWithLuggage('xmod-tally-upi', '9600000002')

    const orderRes = await signedReq(app, 'post', '/parcel-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, senderName: 'Sam', receiverName: 'Riya', receiverPhone: '9888888881', ratePerDayMinor: 2000 },
    })
    const orderId = orderRes.body.data.order._id
    await signedReq(app, 'post', `/parcel-orders/${orderId}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { method: 'UPI', amountMinor: 2000, clientTransactionId: 'ctx-xmod-par-pay-1' },
    })

    const closeRes = await signedReq(app, 'post', `/shifts/${ctx.shiftInstanceId}/close`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { actualCashMinor: 0 },
    })
    expect(closeRes.status).toBe(200)
    expect(closeRes.body.data.expectedCashMinor).toBe(0)
    expect(closeRes.body.data.expectedUpiMinor).toBe(2000)
    expect(closeRes.body.data.varianceMinor).toBe(0)
  });
});

describe('C1: shift transaction drill-down lists Luggage/Parcel payments alongside Parking', () => {
  test('GET /reports/shifts/:id/transactions returns luggageTransactions and parcelTransactions arrays', async () => {
    const ctx = await setUpOrgWithLuggage('xmod-drill', '9600000011')

    const orderRes = await signedReq(app, 'post', '/luggage-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, customerName: 'Drill Customer', customerPhone: '9999999992', ratePerDayMinor: 5000 },
    })
    const orderId = orderRes.body.data.order._id
    const orderCode = orderRes.body.data.order.orderCode
    await signedReq(app, 'post', `/luggage-orders/${orderId}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { method: 'CASH', amountMinor: 1500, clientTransactionId: 'ctx-xmod-drill-pay-1' },
    })

    const res = await signedReq(app, 'get', `/reports/shifts/${ctx.shiftInstanceId}/transactions`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.luggageTransactions.length).toBe(1)
    const row = res.body.data.luggageTransactions[0]
    expect(row.orderCode).toBe(orderCode)
    expect(row.amountMinor).toBe(1500)
    expect(row.method).toBe('CASH')
    expect(res.body.data.parcelTransactions).toEqual([])
  });

  test('GET /reports/shifts/:id/transactions/export returns a CSV including the luggage row', async () => {
    const ctx = await setUpOrgWithLuggage('xmod-drill-export', '9600000012')

    const orderRes = await signedReq(app, 'post', '/luggage-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, customerName: 'Export Customer', customerPhone: '9999999993', ratePerDayMinor: 5000 },
    })
    const orderId = orderRes.body.data.order._id
    await signedReq(app, 'post', `/luggage-orders/${orderId}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { method: 'CASH', amountMinor: 1200, clientTransactionId: 'ctx-xmod-drill-export-1' },
    })

    const res = await signedReq(app, 'get', `/reports/shifts/${ctx.shiftInstanceId}/transactions/export`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.text).toContain('LUGGAGE')
    expect(res.text).toContain('12.00')
  });
});

describe('C1b: summary report exposes per-module revenueByMethod and overdueCount', () => {
  test('GET /reports/summary gives each module its own revenueByMethod and an overdue snapshot count', async () => {
    const ctx = await setUpOrgWithLuggage('xmod-kpi', '9600000031')

    const overdueOrderRes = await signedReq(app, 'post', '/luggage-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, customerName: 'Overdue KPI', customerPhone: '9999999995', ratePerDayMinor: 5000, expectedPickupAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    })
    await signedReq(app, 'post', `/luggage-orders/${overdueOrderRes.body.data.order._id}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { method: 'UPI', amountMinor: 2500, clientTransactionId: 'ctx-xmod-kpi-1' },
    })

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const res = await signedReq(app, 'get', '/reports/summary', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, query: { from, to } })

    expect(res.status).toBe(200)
    expect(res.body.data.byModule.luggage.revenueByMethod.UPI.totalMinor).toBe(2500)
    expect(res.body.data.byModule.parking.revenueByMethod).toEqual({})
    expect(res.body.data.byModule.luggage.overdueCount).toBe(1)
    expect(res.body.data.byModule.parcel.overdueCount).toBe(0)
  });
});

describe('C2: corrections CSV export', () => {
  test('GET /reports/corrections/export returns a CSV of the override', async () => {
    const ctx = await setUpOrgWithLuggage('xmod-corr-export', '9600000021')

    const orderRes = await signedReq(app, 'post', '/luggage-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, customerName: 'Override Customer', customerPhone: '9999999994', ratePerDayMinor: 5000 },
    })
    const orderId = orderRes.body.data.order._id
    await signedReq(app, 'post', `/luggage-orders/${orderId}/override-amount`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { manualAmountMinor: 4000, reason: 'goodwill discount' },
    })

    const res = await signedReq(app, 'get', '/reports/corrections/export', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      query: { entityType: 'LuggageOrder' },
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.text).toContain('goodwill discount')
  });
});
