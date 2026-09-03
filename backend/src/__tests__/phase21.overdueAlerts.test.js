/**
 * Coverage for overdueAlert.service.js — the automatic "identify and notify"
 * sweep described in server.js's boot block. Rather than exercise the real
 * setInterval, these tests call scanAndNotifyOverdue() directly (same
 * black-box Supertest-against-real-app-plus-in-memory-replica-set style as
 * the rest of this suite) and assert on the Notification rows it produces.
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

async function enableModules(orgId, modules) {
  const res = await request(app).patch(`/platform/organizations/${orgId}/modules`).set('Authorization', `Bearer ${platformToken}`).send(modules)
  expect(res.status).toBe(200)
}

async function setUpOrg(code, adminPhone, modules) {
  const org = await onboardOrg(app, { platformToken, code, countryId, adminPhone })
  const orgId = org.organization._id
  await enableModules(orgId, modules)

  const { token: adminToken } = await staffLogin(app, code, adminPhone, 'Admin@123')
  const deviceUuid = `device-${code}`
  const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: `${code} Lot`, geo: { lat: 12.9716, lng: 77.5946 }, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
  })
  expect(locRes.status).toBe(201)
  const locationId = locRes.body.data.location._id

  const shiftRes = await signedReq(app, 'post', '/shifts/start', {
    token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 },
  })
  expect(shiftRes.status).toBe(201)

  return { orgId, adminToken, deviceUuid, deviceSecret, locationId }
}

const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner21@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner21@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

describe('overdueAlert.service: automatic overdue-pickup detection', () => {
  test('notifies MANAGER/ORG_ADMIN once for an overdue luggage order, and does not double-notify on a second sweep', async () => {
    const { scanAndNotifyOverdue } = require('../services/overdueAlert.service')
    const ctx = await setUpOrg('ovd-lug', '9500000001', { LUGGAGE: true })

    const createRes = await signedReq(app, 'post', '/luggage-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, customerName: 'Overdue Alex', customerPhone: '9999999999', ratePerDayMinor: 5000, expectedPickupAt: PAST },
    })
    expect(createRes.status).toBe(201)
    const orderId = createRes.body.data.order._id

    const notBefore = await signedReq(app, 'get', '/notifications', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret })
    expect(notBefore.body.data.notifications.some((n) => n.type === 'LUGGAGE_OVERDUE_PICKUP')).toBe(false)

    const result1 = await scanAndNotifyOverdue()
    expect(result1.luggageCount).toBeGreaterThanOrEqual(1)

    const notAfter = await signedReq(app, 'get', '/notifications', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret })
    const matches = notAfter.body.data.notifications.filter((n) => n.type === 'LUGGAGE_OVERDUE_PICKUP' && n.entityRef?.luggageOrderId === orderId)
    expect(matches.length).toBe(1)
    expect(matches[0].severity).toBe('WARNING')

    // Second sweep must not re-notify the same order (overdueNotifiedAt guard).
    await scanAndNotifyOverdue()
    const notAfter2 = await signedReq(app, 'get', '/notifications', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret })
    const matches2 = notAfter2.body.data.notifications.filter((n) => n.type === 'LUGGAGE_OVERDUE_PICKUP' && n.entityRef?.luggageOrderId === orderId)
    expect(matches2.length).toBe(1)
  });

  test('notifies for an overdue parcel order', async () => {
    const { scanAndNotifyOverdue } = require('../services/overdueAlert.service')
    const ctx = await setUpOrg('ovd-par', '9500000002', { PARCEL: true })

    const createRes = await signedReq(app, 'post', '/parcel-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, senderName: 'Sam', receiverName: 'Riya', receiverPhone: '9888888888', ratePerDayMinor: 3000, expectedPickupAt: PAST },
    })
    expect(createRes.status).toBe(201)
    const orderId = createRes.body.data.order._id

    await scanAndNotifyOverdue()

    const notAfter = await signedReq(app, 'get', '/notifications', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret })
    const matches = notAfter.body.data.notifications.filter((n) => n.type === 'PARCEL_OVERDUE_PICKUP' && n.entityRef?.parcelOrderId === orderId)
    expect(matches.length).toBe(1)
  });

  test('does not notify for an order whose expected pickup is still in the future', async () => {
    const { scanAndNotifyOverdue } = require('../services/overdueAlert.service')
    const ctx = await setUpOrg('ovd-future', '9500000003', { LUGGAGE: true })

    const createRes = await signedReq(app, 'post', '/luggage-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, customerName: 'Not Yet', customerPhone: '9777777777', ratePerDayMinor: 5000, expectedPickupAt: FUTURE },
    })
    expect(createRes.status).toBe(201)
    const orderId = createRes.body.data.order._id

    await scanAndNotifyOverdue()

    const notAfter = await signedReq(app, 'get', '/notifications', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret })
    const matches = notAfter.body.data.notifications.filter((n) => n.entityRef?.luggageOrderId === orderId)
    expect(matches.length).toBe(0)
  });
});
