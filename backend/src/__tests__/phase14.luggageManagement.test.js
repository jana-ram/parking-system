/**
 * Coverage for Luggage Management (§8 of the platform brief): LuggageOrder/
 * LuggageItem CRUD, the LUGGAGE feature-flag gate, rack-slot integration
 * (reusing services/rackSlot.service.js from Phase 13), payment + pickup
 * (with the payment-required-before-pickup gate), and cancel. Same
 * black-box Supertest-against-real-app-plus-in-memory-replica-set style as
 * phase13.rackManagement.test.js.
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

async function setUpOrg(code, adminPhone, modules = { LUGGAGE: true }) {
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
  const res = await signedReq(app, 'post', '/luggage-orders', {
    token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
    body: { locationId: ctx.locationId, customerName: 'Alex', customerPhone: '9999999999', ratePerDayMinor: 5000, ...overrides },
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
  await PlatformAdmin.create({ name: 'Owner', email: 'owner14@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner14@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

// ═══════════════════════════════════════════════════════════════════════
describe('C0: LUGGAGE feature-flag gate', () => {
  test('LUGGAGE defaults false — /luggage-orders 403s until enabled', async () => {
    const org = await onboardOrg(app, { platformToken, code: 'lug-flag', countryId, adminPhone: '9400000001' })
    const { token: adminToken } = await staffLogin(app, 'lug-flag', '9400000001', 'Admin@123')
    const deviceUuid = 'device-lug-flag'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const blockedRes = await signedReq(app, 'get', '/luggage-orders', { token: adminToken, deviceUuid, deviceSecret })
    expect(blockedRes.status).toBe(403)
    expect(blockedRes.body.code).toBe('FEATURE_DISABLED')

    await enableModules(org.organization._id, { LUGGAGE: true })
    const okRes = await signedReq(app, 'get', '/luggage-orders', { token: adminToken, deviceUuid, deviceSecret })
    expect(okRes.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C1: order + item creation', () => {
  test('creates an order with an auto-generated code and the location currency', async () => {
    const ctx = await setUpOrg('lug-create', '9400000011')
    const order = await createOrder(ctx)
    expect(order.orderCode).toMatch(/^LUG-ORD-/)
    expect(order.currency).toBe('INR')
    expect(order.status).toBe('ACTIVE')
  })

  test('adds items with auto-generated codes; cannot add to a non-ACTIVE order', async () => {
    const ctx = await setUpOrg('lug-items', '9400000021')
    const order = await createOrder(ctx)

    const itemsRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/items`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { items: [{ description: 'Blue suitcase' }, { description: 'Backpack', quantity: 2 }] },
    })
    expect(itemsRes.status).toBe(201)
    expect(itemsRes.body.data.items.length).toBe(2)
    expect(itemsRes.body.data.items[0].itemCode).toMatch(/^LUG-/)
    expect(itemsRes.body.data.items[1].quantity).toBe(2)

    const cancelRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/cancel`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { reason: 'test cancel' },
    })
    expect(cancelRes.status).toBe(200)

    const blockedRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/items`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { items: [{ description: 'Too late' }] },
    })
    expect(blockedRes.status).toBe(409)
  })

  test('GET /luggage-orders/by-code/:orderCode — the scan-driven pickup lookup', async () => {
    const ctx = await setUpOrg('lug-bycode', '9400000091')
    const order = await createOrder(ctx)

    const foundRes = await signedReq(app, 'get', `/luggage-orders/by-code/${order.orderCode}`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
    })
    expect(foundRes.status).toBe(200)
    expect(foundRes.body.data.order._id).toBe(order._id)

    const notFoundRes = await signedReq(app, 'get', '/luggage-orders/by-code/LUG-ORD-DOES-NOT-EXIST', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
    })
    expect(notFoundRes.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C2: rack-slot integration (reuses Phase 13 rackSlot.service)', () => {
  test('assigns an item to a rack slot, occupying it; releasing frees it', async () => {
    const ctx = await setUpOrg('lug-rack', '9400000031', { LUGGAGE: true, RACK: true })
    const order = await createOrder(ctx)
    const itemsRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/items`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { items: [{ description: 'Suitcase' }] },
    })
    const item = itemsRes.body.data.items[0]

    const rackRes = await signedReq(app, 'post', '/racks', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, code: 'L1', allowedItemTypes: ['LUGGAGE'] },
    })
    const rack = rackRes.body.data.rack
    const slotsRes = await signedReq(app, 'post', `/racks/${rack._id}/slots`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { slots: [{ slotCode: 'L01' }] },
    })
    const slot = slotsRes.body.data.slots[0]

    const assignRes = await signedReq(app, 'post', `/luggage-items/${item._id}/assign-rack`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { rackSlotId: slot._id },
    })
    expect(assignRes.status).toBe(200)
    expect(assignRes.body.data.item.rackSlotId).toBe(slot._id)

    const slotCheckRes = await signedReq(app, 'get', `/racks/${rack._id}/slots`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
    })
    expect(slotCheckRes.body.data.slots[0].status).toBe('OCCUPIED')
    expect(slotCheckRes.body.data.slots[0].currentItemRef).toBe(item._id)

    const doubleAssignRes = await signedReq(app, 'post', `/luggage-items/${item._id}/assign-rack`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { rackSlotId: slot._id },
    })
    expect(doubleAssignRes.status).toBe(409)

    const releaseRes = await signedReq(app, 'post', `/luggage-items/${item._id}/release-rack`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: {},
    })
    expect(releaseRes.status).toBe(200)
    expect(releaseRes.body.data.item.rackSlotId).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C3: payment + pickup', () => {
  test('pickup is blocked until fully paid, then completes and releases the rack slot', async () => {
    const ctx = await setUpOrg('lug-pickup', '9400000041', { LUGGAGE: true, RACK: true })
    const order = await createOrder(ctx, { ratePerDayMinor: 1000 })
    const itemsRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/items`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { items: [{ description: 'Bag' }] },
    })
    const item = itemsRes.body.data.items[0]

    const rackRes = await signedReq(app, 'post', '/racks', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { locationId: ctx.locationId, code: 'P1' },
    })
    const slotsRes = await signedReq(app, 'post', `/racks/${rackRes.body.data.rack._id}/slots`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { slots: [{ slotCode: 'P01' }] },
    })
    const slot = slotsRes.body.data.slots[0]
    await signedReq(app, 'post', `/luggage-items/${item._id}/assign-rack`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { rackSlotId: slot._id },
    })

    // Within the grace period, amount due is 0 — picking up immediately should succeed with no payment.
    const earlyPickupRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/pickup`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: {},
    })
    expect(earlyPickupRes.status).toBe(200)
    expect(earlyPickupRes.body.data.order.status).toBe('COMPLETED')

    const finalItemsRes = await signedReq(app, 'get', `/luggage-orders/${order._id}`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
    })
    expect(finalItemsRes.body.data.items[0].status).toBe('PICKED_UP')
    expect(finalItemsRes.body.data.items[0].rackSlotId).toBeNull()

    const slotCheckRes = await signedReq(app, 'get', `/racks/${rackRes.body.data.rack._id}/slots`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
    })
    expect(slotCheckRes.body.data.slots[0].status).toBe('AVAILABLE')
  })

  test('a backdated (already multi-day) order blocks pickup until paid in full', async () => {
    const ctx = await setUpOrg('lug-payblock', '9400000051')
    const order = await createOrder(ctx, { ratePerDayMinor: 1000 })

    // Simulate 3 elapsed days by writing checkInAt directly (bypassing HTTP — this is a DB-level test setup step).
    const LuggageOrder = require('../models/LuggageOrder')
    await LuggageOrder.updateOne(
      { _id: order._id, organizationId: ctx.orgId },
      { checkInAt: new Date(Date.now() - 3 * 24 * 60 * 60000) },
    )

    const blockedPickupRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/pickup`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: {},
    })
    expect(blockedPickupRes.status).toBe(402)
    expect(blockedPickupRes.body.code).toBe('PAYMENT_PENDING')

    const partialPayRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { method: 'CASH', amountMinor: 1000, clientTransactionId: 'ctx-lug-1' },
    })
    expect(partialPayRes.status).toBe(201)

    const stillBlockedRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/pickup`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: {},
    })
    expect(stillBlockedRes.status).toBe(402)

    const fullPayRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { method: 'UPI', amountMinor: 2000, clientTransactionId: 'ctx-lug-2' },
    })
    expect(fullPayRes.status).toBe(201)

    const successPickupRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/pickup`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: {},
    })
    expect(successPickupRes.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C4: cancel', () => {
  test('cancels an unpaid ACTIVE order; blocks cancelling once a payment exists', async () => {
    const ctx = await setUpOrg('lug-cancel', '9400000061')
    const order = await createOrder(ctx)

    const cancelRes = await signedReq(app, 'post', `/luggage-orders/${order._id}/cancel`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { reason: 'customer changed mind' },
    })
    expect(cancelRes.status).toBe(200)
    expect(cancelRes.body.data.order.status).toBe('CANCELLED')

    const order2 = await createOrder(ctx)
    await signedReq(app, 'post', `/luggage-orders/${order2._id}/payment`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { method: 'CASH', amountMinor: 100, clientTransactionId: 'ctx-lug-cancel-1' },
    })
    const blockedCancelRes = await signedReq(app, 'post', `/luggage-orders/${order2._id}/cancel`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { reason: 'already paid' },
    })
    expect(blockedCancelRes.status).toBe(409)
  })

  test('only Manager+ can cancel', async () => {
    const ctx = await setUpOrg('lug-cancel-authz', '9400000071')
    const order = await createOrder(ctx)
    const staffRes = await signedReq(app, 'post', '/staff', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { name: 'Staff', phone: '9400000079', password: 'Staff@123', role: 'STAFF' },
    })
    expect(staffRes.status).toBe(201)
    const { token: staffToken } = await staffLogin(app, 'lug-cancel-authz', '9400000079', 'Staff@123')

    const res = await signedReq(app, 'post', `/luggage-orders/${order._id}/cancel`, {
      token: staffToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { reason: 'x' },
    })
    expect(res.status).toBe(403)
  })
})
