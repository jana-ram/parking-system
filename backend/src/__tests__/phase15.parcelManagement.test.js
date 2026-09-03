/**
 * Coverage for Parcel Management (§9 of the platform brief) — structurally
 * a mirror of phase14.luggageManagement.test.js: ParcelOrder/ParcelItem
 * CRUD, the PARCEL feature-flag gate, rack-slot integration, payment +
 * pickup, and cancel.
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

async function setUpOrg(code, adminPhone, modules = { PARCEL: true }) {
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

async function createOrder(ctx, overrides = {}) {
  const res = await signedReq(app, 'post', '/parcel-orders', {
    token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
    body: { locationId: ctx.locationId, senderName: 'Sender Co', receiverName: 'Riya', receiverPhone: '9888888888', ratePerDayMinor: 3000, ...overrides },
  })
  expect(res.status).toBe(201)
  return res.body.data.order
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner15@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner15@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

// ═══════════════════════════════════════════════════════════════════════
describe('C0: PARCEL feature-flag gate', () => {
  test('PARCEL defaults false — /parcel-orders 403s until enabled', async () => {
    const org = await onboardOrg(app, { platformToken, code: 'par-flag', countryId, adminPhone: '9500000001' })
    const { token: adminToken } = await staffLogin(app, 'par-flag', '9500000001', 'Admin@123')
    const deviceUuid = 'device-par-flag'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const blockedRes = await signedReq(app, 'get', '/parcel-orders', { token: adminToken, deviceUuid, deviceSecret })
    expect(blockedRes.status).toBe(403)
    expect(blockedRes.body.code).toBe('FEATURE_DISABLED')

    await enableModules(org.organization._id, { PARCEL: true })
    const okRes = await signedReq(app, 'get', '/parcel-orders', { token: adminToken, deviceUuid, deviceSecret })
    expect(okRes.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C1: order + item creation', () => {
  test('creates an order with an auto-generated code and the location currency', async () => {
    const ctx = await setUpOrg('par-create', '9500000011')
    const order = await createOrder(ctx)
    expect(order.orderCode).toMatch(/^PAR-ORD-/)
    expect(order.currency).toBe('INR')
    expect(order.status).toBe('ACTIVE')
  })

  test('adds items with auto-generated codes; cannot add to a non-ACTIVE order', async () => {
    const ctx = await setUpOrg('par-items', '9500000021')
    const order = await createOrder(ctx)

    const itemsRes = await signedReq(app, 'post', `/parcel-orders/${order._id}/items`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { items: [{ parcelType: 'Box', description: 'Books' }, { parcelType: 'Envelope', quantity: 3 }] },
    })
    expect(itemsRes.status).toBe(201)
    expect(itemsRes.body.data.items.length).toBe(2)
    expect(itemsRes.body.data.items[0].itemCode).toMatch(/^PAR-/)
    expect(itemsRes.body.data.items[1].quantity).toBe(3)

    const cancelRes = await signedReq(app, 'post', `/parcel-orders/${order._id}/cancel`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { reason: 'test cancel' },
    })
    expect(cancelRes.status).toBe(200)

    const blockedRes = await signedReq(app, 'post', `/parcel-orders/${order._id}/items`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { items: [{ parcelType: 'Too late' }] },
    })
    expect(blockedRes.status).toBe(409)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C2: rack-slot integration', () => {
  test('assigns an item to a rack slot, occupying it; releasing frees it', async () => {
    const ctx = await setUpOrg('par-rack', '9500000031', { PARCEL: true, RACK: true })
    const order = await createOrder(ctx)
    const itemsRes = await signedReq(app, 'post', `/parcel-orders/${order._id}/items`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { items: [{ parcelType: 'Box' }] },
    })
    const item = itemsRes.body.data.items[0]

    const rackRes = await signedReq(app, 'post', '/racks', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, code: 'PL1', allowedItemTypes: ['PARCEL'] },
    })
    const rack = rackRes.body.data.rack
    const slotsRes = await signedReq(app, 'post', `/racks/${rack._id}/slots`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { slots: [{ slotCode: 'PL01' }] },
    })
    const slot = slotsRes.body.data.slots[0]

    const assignRes = await signedReq(app, 'post', `/parcel-items/${item._id}/assign-rack`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { rackSlotId: slot._id },
    })
    expect(assignRes.status).toBe(200)
    expect(assignRes.body.data.item.rackSlotId).toBe(slot._id)

    const slotCheckRes = await signedReq(app, 'get', `/racks/${rack._id}/slots`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
    })
    expect(slotCheckRes.body.data.slots[0].status).toBe('OCCUPIED')
    expect(slotCheckRes.body.data.slots[0].currentItemType).toBe('PARCEL')

    const releaseRes = await signedReq(app, 'post', `/parcel-items/${item._id}/release-rack`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: {},
    })
    expect(releaseRes.status).toBe(200)
    expect(releaseRes.body.data.item.rackSlotId).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C3: payment + pickup', () => {
  test('pickup is blocked until fully paid for a backdated order, then completes', async () => {
    const ctx = await setUpOrg('par-pickup', '9500000041')
    const order = await createOrder(ctx, { ratePerDayMinor: 1000 })

    const ParcelOrder = require('../models/ParcelOrder')
    await ParcelOrder.updateOne(
      { _id: order._id, organizationId: ctx.orgId },
      { receivedAt: new Date(Date.now() - 2 * 24 * 60 * 60000) },
    )

    const blockedRes = await signedReq(app, 'post', `/parcel-orders/${order._id}/pickup`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: {},
    })
    expect(blockedRes.status).toBe(402)
    expect(blockedRes.body.code).toBe('PAYMENT_PENDING')

    const payRes = await signedReq(app, 'post', `/parcel-orders/${order._id}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { method: 'CASH', amountMinor: 3000, clientTransactionId: 'ctx-par-1' },
    })
    expect(payRes.status).toBe(201)

    const pickupRes = await signedReq(app, 'post', `/parcel-orders/${order._id}/pickup`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: {},
    })
    expect(pickupRes.status).toBe(200)
    expect(pickupRes.body.data.order.status).toBe('COMPLETED')
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C4: cancel', () => {
  test('cancels an unpaid ACTIVE order; blocks cancelling once a payment exists; Manager+ only', async () => {
    const ctx = await setUpOrg('par-cancel', '9500000051')
    const order = await createOrder(ctx)
    const cancelRes = await signedReq(app, 'post', `/parcel-orders/${order._id}/cancel`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { reason: 'sender withdrew' },
    })
    expect(cancelRes.status).toBe(200)

    const order2 = await createOrder(ctx)
    await signedReq(app, 'post', `/parcel-orders/${order2._id}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { method: 'CASH', amountMinor: 100, clientTransactionId: 'ctx-par-cancel-1' },
    })
    const blockedCancelRes = await signedReq(app, 'post', `/parcel-orders/${order2._id}/cancel`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { reason: 'already paid' },
    })
    expect(blockedCancelRes.status).toBe(409)

    const staffRes = await signedReq(app, 'post', '/staff', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { name: 'Staff', phone: '9500000059', password: 'Staff@123', role: 'STAFF' },
    })
    expect(staffRes.status).toBe(201)
    const { token: staffToken } = await staffLogin(app, 'par-cancel', '9500000059', 'Staff@123')
    const order3 = await createOrder(ctx)
    const authzRes = await signedReq(app, 'post', `/parcel-orders/${order3._id}/cancel`, {
      token: staffToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { reason: 'not allowed' },
    })
    expect(authzRes.status).toBe(403)
  })
})
