/**
 * Coverage for §24 Customer Self-Service: the one router reachable with no
 * staff JWT at all. Verifies the CUSTOMER_SELF_SERVICE (and per-domain
 * LUGGAGE/PARCEL) feature gate, the phone+orderCode pairing requirement,
 * and that a wrong phone/org/code all fail identically (no information
 * leak about which part was wrong).
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

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner20@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner20@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

describe('Public luggage/parcel status lookup', () => {
  test('404s while CUSTOMER_SELF_SERVICE is off; works once enabled; wrong phone/orgCode both 404', async () => {
    const code = 'selfserve-lug'
    const org = await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9990000001' })
    await enableModules(org.organization._id, { LUGGAGE: true })
    const { token: adminToken } = await staffLogin(app, code, '9990000001', 'Admin@123')
    const deviceUuid = 'device-selfserve-lug'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)
    const locRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: 'Selfserve Lot', geo: { lat: 12.9716, lng: 77.5946 }, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
    })
    const locationId = locRes.body.data.location._id
    await signedReq(app, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
    const orderRes = await signedReq(app, 'post', '/luggage-orders', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { locationId, customerName: 'Kavya', customerPhone: '9991112222', ratePerDayMinor: 2000 },
    })
    const order = orderRes.body.data.order
    await signedReq(app, 'post', `/luggage-orders/${order._id}/items`, {
      token: adminToken, deviceUuid, deviceSecret, body: { items: [{ description: 'Backpack' }] },
    })

    // Feature still off (only LUGGAGE was enabled, not CUSTOMER_SELF_SERVICE).
    const blockedRes = await request(app).get(`/public/${code}/luggage/${order.orderCode}`).query({ phone: '9991112222' })
    expect(blockedRes.status).toBe(404)

    await enableModules(org.organization._id, { CUSTOMER_SELF_SERVICE: true })

    const okRes = await request(app).get(`/public/${code}/luggage/${order.orderCode}`).query({ phone: '9991112222' })
    expect(okRes.status).toBe(200)
    expect(okRes.body.data.order.orderCode).toBe(order.orderCode)
    expect(okRes.body.data.items.length).toBe(1)
    expect(okRes.body.data.items[0].description).toBe('Backpack')

    const wrongPhoneRes = await request(app).get(`/public/${code}/luggage/${order.orderCode}`).query({ phone: '0000000000' })
    expect(wrongPhoneRes.status).toBe(404)

    const wrongOrgRes = await request(app).get(`/public/nonexistent-org/luggage/${order.orderCode}`).query({ phone: '9991112222' })
    expect(wrongOrgRes.status).toBe(404)

    const missingPhoneRes = await request(app).get(`/public/${code}/luggage/${order.orderCode}`)
    expect(missingPhoneRes.status).toBe(422)
  })

  test('parcel lookup matches either sender or receiver phone', async () => {
    const code = 'selfserve-par'
    const org = await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9990000011' })
    await enableModules(org.organization._id, { PARCEL: true, CUSTOMER_SELF_SERVICE: true })
    const { token: adminToken } = await staffLogin(app, code, '9990000011', 'Admin@123')
    const deviceUuid = 'device-selfserve-par'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)
    const locRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: 'Selfserve Parcel Lot', geo: { lat: 12.9716, lng: 77.5946 }, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
    })
    const locationId = locRes.body.data.location._id
    await signedReq(app, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
    const orderRes = await signedReq(app, 'post', '/parcel-orders', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { locationId, senderName: 'Sender Co', receiverName: 'Divya', receiverPhone: '9993334444', ratePerDayMinor: 1500 },
    })
    const order = orderRes.body.data.order

    const res = await request(app).get(`/public/${code}/parcel/${order.orderCode}`).query({ phone: '9993334444' })
    expect(res.status).toBe(200)
    expect(res.body.data.order.orderCode).toBe(order.orderCode)
  })
})
