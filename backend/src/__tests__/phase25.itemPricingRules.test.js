/**
 * Coverage for Luggage/Parcel pricing configuration (§2 of the platform
 * brief: "add separate pricing configuration for Luggage and Parcel...
 * support hourly/daily/multiple-day pricing"). ItemPricingRule.js is
 * deliberately a simpler shape than Parking's rule+immutable-version
 * system — one mutable rule row per module/location, CRUD-only. This suite
 * covers create/list/update, the check-in resolution path (pricingRuleId ->
 * snapshotted rate/unit/maxDays on the order), the manual-rate fallback
 * staying intact, and the hourly-with-cap billing math end to end through
 * a real payment.
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

async function setUpOrg(code, adminPhone, modules) {
  const org = await onboardOrg(app, { platformToken, code, countryId, adminPhone })
  await enableModules(org.organization._id, modules)
  const { token: adminToken } = await staffLogin(app, code, adminPhone, 'Admin@123')
  const deviceUuid = `device-${code}`
  const deviceSecret = await registerDevice(app, adminToken, deviceUuid)
  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: `${code} Lot`, geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
  })
  const locationId = locRes.body.data.location._id
  await signedReq(app, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
  return { orgId: org.organization._id, adminToken, deviceUuid, deviceSecret, locationId }
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner25@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner25@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

describe('C0: ItemPricingRule CRUD', () => {
  test('ORG_ADMIN can create, list, and update a Luggage pricing rule; a Manager without pricing.edit-equivalent role cannot write', async () => {
    const ctx = await setUpOrg('ipr-crud', '9920000001', { LUGGAGE: true })

    const createRes = await signedReq(app, 'post', '/item-pricing-rules', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { module: 'LUGGAGE', locationId: ctx.locationId, name: 'Hourly Bags', unit: 'HOUR', rateMinor: 2000, maxDays: 3 },
    })
    expect(createRes.status).toBe(201)
    const ruleId = createRes.body.data.rule._id

    const listRes = await signedReq(app, 'get', '/item-pricing-rules', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, query: { module: 'LUGGAGE' } })
    expect(listRes.status).toBe(200)
    expect(listRes.body.data.rules.find((r) => r._id === ruleId)).toBeDefined()

    const updateRes = await signedReq(app, 'patch', `/item-pricing-rules/${ruleId}`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { rateMinor: 2500 },
    })
    expect(updateRes.status).toBe(200)
    expect(updateRes.body.data.rule.rateMinor).toBe(2500)

    const managerRes = await signedReq(app, 'post', '/staff', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { name: 'Manager Item', phone: '9920000009', password: 'Manager@123', role: 'MANAGER' },
    })
    expect(managerRes.status).toBe(201)
    const { token: managerToken } = await staffLogin(app, 'ipr-crud', '9920000009', 'Manager@123')
    const blockedRes = await signedReq(app, 'post', '/item-pricing-rules', {
      token: managerToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { module: 'LUGGAGE', name: 'Manager Rule', unit: 'DAY', rateMinor: 1000 },
    })
    expect(blockedRes.status).toBe(403)
  });

  test('creating a rule for a disabled module is rejected', async () => {
    const ctx = await setUpOrg('ipr-disabled', '9920000002', { LUGGAGE: true })
    const res = await signedReq(app, 'post', '/item-pricing-rules', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { module: 'PARCEL', name: 'Not Enabled', unit: 'DAY', rateMinor: 1000 },
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FEATURE_DISABLED')
  });
});

describe('C1: check-in resolves a pricingRuleId into a snapshotted rate/unit/maxDays', () => {
  test('a Luggage order created with pricingRuleId inherits the rule\'s unit and rate, and bills accordingly', async () => {
    const ctx = await setUpOrg('ipr-checkin', '9920000003', { LUGGAGE: true })
    const ruleRes = await signedReq(app, 'post', '/item-pricing-rules', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { module: 'LUGGAGE', name: 'Hourly', unit: 'HOUR', rateMinor: 1500, maxDays: 2 },
    })
    const ruleId = ruleRes.body.data.rule._id

    const orderRes = await signedReq(app, 'post', '/luggage-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, customerName: 'Rule Customer', customerPhone: '9999999981', pricingRuleId: ruleId },
    })
    expect(orderRes.status).toBe(201)
    expect(orderRes.body.data.order.pricingUnit).toBe('HOUR')
    expect(orderRes.body.data.order.ratePerDayMinor).toBe(1500)
    expect(orderRes.body.data.order.maxDays).toBe(2)
  });

  test('an inactive/unknown pricingRuleId is rejected with 404, not silently falling back', async () => {
    const ctx = await setUpOrg('ipr-badrule', '9920000004', { LUGGAGE: true })
    const res = await signedReq(app, 'post', '/luggage-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, customerName: 'Bad Rule', customerPhone: '9999999982', pricingRuleId: '6a0000000000000000000000' },
    })
    expect(res.status).toBe(404)
  });

  test('omitting both pricingRuleId and ratePerDayMinor is rejected — check-in is never silently free', async () => {
    const ctx = await setUpOrg('ipr-norate', '9920000005', { LUGGAGE: true })
    const res = await signedReq(app, 'post', '/luggage-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, customerName: 'No Rate', customerPhone: '9999999983' },
    })
    expect(res.status).toBe(422)
  });

  test('the pre-existing manual ratePerDayMinor path still works unchanged (no pricingRuleId given)', async () => {
    const ctx = await setUpOrg('ipr-manual', '9920000006', { LUGGAGE: true })
    const res = await signedReq(app, 'post', '/luggage-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, customerName: 'Manual Rate', customerPhone: '9999999984', ratePerDayMinor: 4000 },
    })
    expect(res.status).toBe(201)
    expect(res.body.data.order.ratePerDayMinor).toBe(4000)
    expect(res.body.data.order.pricingUnit).toBe('DAY')
  });
});

describe('C2: hourly Parcel pricing bills correctly end to end, including the maxDays cap', () => {
  test('a Parcel order on an hourly rule with a maxDays cap charges the capped amount after a long stay', async () => {
    const ctx = await setUpOrg('ipr-parcel-hourly', '9920000007', { PARCEL: true })
    const ruleRes = await signedReq(app, 'post', '/item-pricing-rules', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { module: 'PARCEL', name: 'Hourly Capped', unit: 'HOUR', rateMinor: 1000, maxDays: 1 },
    })
    const ruleId = ruleRes.body.data.rule._id

    const orderRes = await signedReq(app, 'post', '/parcel-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, senderName: 'Sam', receiverName: 'Riya', receiverPhone: '9999999985', pricingRuleId: ruleId },
    })
    const orderId = orderRes.body.data.order._id

    // Directly age the order's checkInAt-equivalent (receivedAt) past the
    // cap window — a real multi-day wait isn't practical to simulate via
    // the API's clock, and receivedAt isn't settable through createOrder's
    // request body (unlike Parking's entryAt), so this is the pragmatic way
    // to exercise the cap in a fast test, same as other suites reach into
    // the DB directly for time-travel setups.
    const ParcelOrder = require('../models/ParcelOrder')
    await ParcelOrder.updateOne({ _id: orderId, organizationId: ctx.orgId }, { $set: { receivedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) } })

    const payRes = await signedReq(app, 'post', `/parcel-orders/${orderId}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { method: 'CASH', amountMinor: 24 * 1000, clientTransactionId: 'ctx-ipr-parcel-cap-1' },
    })
    expect(payRes.status).toBe(201)
    // Capped at maxDays(1) * 24h * rateMinor(1000) = 24000, not the ~120000
    // an uncapped 5-day-old hourly rate would charge.
    expect(payRes.body.data.order.amountDueMinor).toBe(24 * 1000)

    const pickupRes = await signedReq(app, 'post', `/parcel-orders/${orderId}/pickup`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: {},
    })
    expect(pickupRes.status).toBe(200)
    expect(pickupRes.body.data.order.status).toBe('COMPLETED')
  });
});
