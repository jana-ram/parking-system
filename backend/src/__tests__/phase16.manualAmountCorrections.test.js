/**
 * Coverage for §12 (Manual Amount) / §15 (Audit-friendly corrections): the
 * generic services/correction.service.js primitive and its three call sites
 * — ParkingSession.overrideAmount, LuggageOrder.overrideAmount,
 * ParcelOrder.overrideAmount. Verifies the amount actually changes, a
 * Correction record is written with old/new/reason/actor, Manager+-only
 * enforcement, and that a completed/cancelled entity can't be overridden.
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

const GOOD_GEO = { lat: 12.9716, lng: 77.5946 }
function goodLocationCheck(overrides = {}) {
  return { lat: GOOD_GEO.lat, lng: GOOD_GEO.lng, accuracyM: 10, mockDetected: false, ...overrides }
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
    body: { countryId, name: `${code} Lot`, geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
  })
  expect(locRes.status).toBe(201)
  const locationId = locRes.body.data.location._id

  const shiftRes = await signedReq(app, 'post', '/shifts/start', {
    token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 },
  })
  expect(shiftRes.status).toBe(201)

  return { orgId, adminToken, deviceUuid, deviceSecret, locationId }
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner16@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner16@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

// ═══════════════════════════════════════════════════════════════════════
describe('C0: ParkingSession override-amount', () => {
  test('Manager+ can override amountDueMinor while PAYMENT_PENDING; a Correction is recorded; payment then uses the new amount', async () => {
    const ctx = await setUpOrg('corr-session', '9600000001', { PARKING: true })

    const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { code: 'BIKE', name: 'Bike' } })
    const vehicleTypeId = vtRes.body.data.vehicleType._id
    const ruleRes = await signedReq(app, 'post', '/pricing-rules', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, vehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Bike flat', config: { flatAmountMinor: 2000 } },
    })
    expect(ruleRes.status).toBe(201)
    const batchRes = await signedReq(app, 'post', '/tokens/batches', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { locationId: ctx.locationId, batchSize: 1 } })
    const tokenCode = batchRes.body.data.tokens[0].tokenCode

    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { clientTransactionId: 'ctx-corr-1', locationId: ctx.locationId, vehicleNumber: 'KA01AB1234', vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    expect(entryRes.status).toBe(201)
    expect(entryRes.body.data.status).toBe('PAYMENT_PENDING')
    expect(entryRes.body.data.amountDueMinor).toBe(2000)
    const sessionId = entryRes.body.data.sessionId

    const overrideRes = await signedReq(app, 'post', `/sessions/${sessionId}/override-amount`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { manualAmountMinor: 1500, reason: 'Regular customer discount' },
    })
    expect(overrideRes.status).toBe(200)
    expect(overrideRes.body.data.amountDueMinor).toBe(1500)

    const Correction = require('../models/Correction')
    const corrections = await Correction.find({ organizationId: ctx.orgId, entityType: 'ParkingSession', entityId: sessionId })
    expect(corrections.length).toBe(1)
    expect(corrections[0].field).toBe('amountDueMinor')
    expect(corrections[0].oldValue).toBe(2000)
    expect(corrections[0].newValue).toBe(1500)
    expect(corrections[0].reason).toBe('Regular customer discount')
    expect(corrections[0].requestedBy).toBeTruthy()
    expect(corrections[0].approvedBy).toBeTruthy()

    const payRes = await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { clientTransactionId: 'ctx-corr-pay-1', method: 'CASH', amountMinor: 1500 },
    })
    expect(payRes.status).toBe(201)
    expect(payRes.body.data.status).toBe('PAID')
  })

  test('a non-manager cannot override; a non-PAYMENT_PENDING session cannot be overridden', async () => {
    const ctx = await setUpOrg('corr-session-authz', '9600000011', { PARKING: true })
    const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { code: 'BIKE', name: 'Bike' } })
    const vehicleTypeId = vtRes.body.data.vehicleType._id
    await signedReq(app, 'post', '/pricing-rules', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, vehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Bike flat', config: { flatAmountMinor: 2000 } },
    })
    const batchRes = await signedReq(app, 'post', '/tokens/batches', { token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { locationId: ctx.locationId, batchSize: 1 } })
    const tokenCode = batchRes.body.data.tokens[0].tokenCode
    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { clientTransactionId: 'ctx-corr-2', locationId: ctx.locationId, vehicleNumber: 'KA01AB5678', vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    const sessionId = entryRes.body.data.sessionId

    const staffRes = await signedReq(app, 'post', '/staff', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { name: 'Staff', phone: '9600000019', password: 'Staff@123', role: 'STAFF' },
    })
    expect(staffRes.status).toBe(201)
    const { token: staffToken } = await staffLogin(app, 'corr-session-authz', '9600000019', 'Staff@123')

    const authzRes = await signedReq(app, 'post', `/sessions/${sessionId}/override-amount`, {
      token: staffToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { manualAmountMinor: 100, reason: 'not allowed' },
    })
    expect(authzRes.status).toBe(403)

    const payRes = await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { clientTransactionId: 'ctx-corr-pay-2', method: 'CASH', amountMinor: 2000 },
    })
    expect(payRes.status).toBe(201)

    const lateOverrideRes = await signedReq(app, 'post', `/sessions/${sessionId}/override-amount`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { manualAmountMinor: 100, reason: 'too late' },
    })
    expect(lateOverrideRes.status).toBe(409)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C1: LuggageOrder override-amount', () => {
  test('fixes the due amount, recorded as a Correction, and payment/pickup then use the override instead of recomputing', async () => {
    const ctx = await setUpOrg('corr-luggage', '9600000021', { LUGGAGE: true })
    const orderRes = await signedReq(app, 'post', '/luggage-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, customerName: 'Sam', customerPhone: '9999999998', ratePerDayMinor: 10000 },
    })
    const order = orderRes.body.data.order
    expect(order.amountDueMinor).toBe(0) // within grace period, nothing computed yet

    const overrideRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/override-amount`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { manualAmountMinor: 500, reason: 'Flat courtesy fee' },
    })
    expect(overrideRes.status).toBe(200)
    expect(overrideRes.body.data.order.amountDueMinor).toBe(500)
    expect(overrideRes.body.data.order.manualAmountOverrideMinor).toBe(500)

    const Correction = require('../models/Correction')
    const corrections = await Correction.find({ organizationId: ctx.orgId, entityType: 'LuggageOrder', entityId: order._id })
    expect(corrections.length).toBe(1)
    expect(corrections[0].oldValue).toBe(0)
    expect(corrections[0].newValue).toBe(500)

    // Even though it's still well within the free grace period (would
    // normally compute to 0 due), pickup now requires the overridden 500.
    const blockedPickupRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/pickup`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: {},
    })
    expect(blockedPickupRes.status).toBe(402)

    const payRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { method: 'CASH', amountMinor: 500, clientTransactionId: 'ctx-corr-lug-1' },
    })
    expect(payRes.status).toBe(201)

    const pickupRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/pickup`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: {},
    })
    expect(pickupRes.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C2: ParcelOrder override-amount', () => {
  test('fixes the due amount and is recorded as a Correction', async () => {
    const ctx = await setUpOrg('corr-parcel', '9600000031', { PARCEL: true })
    const orderRes = await signedReq(app, 'post', '/parcel-orders', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, senderName: 'Sender', receiverName: 'Receiver', receiverPhone: '9999999997', ratePerDayMinor: 4000 },
    })
    const order = orderRes.body.data.order

    const overrideRes = await signedReq(app, 'post', `/parcel-orders/${order._id}/override-amount`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { manualAmountMinor: 250, reason: 'Bulk sender rate' },
    })
    expect(overrideRes.status).toBe(200)
    expect(overrideRes.body.data.order.amountDueMinor).toBe(250)

    const Correction = require('../models/Correction')
    const corrections = await Correction.find({ organizationId: ctx.orgId, entityType: 'ParcelOrder', entityId: order._id })
    expect(corrections.length).toBe(1)
    expect(corrections[0].newValue).toBe(250)
  })
})
