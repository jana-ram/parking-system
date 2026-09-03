/**
 * Coverage for Rack Management (§6/§7 of the platform brief): the Rack/
 * RackSlot hierarchy, the RACK feature-flag gate, rack/slot CRUD, smart
 * slot-assignment suggestion, assign/release (shift-bound operational
 * writes), manual status overrides (Manager+ administrative), and movement/
 * audit history. Same black-box Supertest-against-real-app-plus-in-memory-
 * replica-set style as phase12.featureModules.test.js.
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

async function enableRack(orgId) {
  const res = await request(app).patch(`/platform/organizations/${orgId}/modules`).set('Authorization', `Bearer ${platformToken}`).send({ RACK: true })
  expect(res.status).toBe(200)
}

// Builds an org with a location and an OPEN shift for the admin, so
// shift-bound assign/release tests have something real to run against.
async function setUpOrg(code, adminPhone) {
  const org = await onboardOrg(app, { platformToken, code, countryId, adminPhone })
  const orgId = org.organization._id
  await enableRack(orgId)

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

async function createRack(ctx, overrides = {}) {
  const res = await signedReq(app, 'post', '/racks', {
    token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
    body: { locationId: ctx.locationId, code: 'A', name: 'Rack A', allowedItemTypes: ['LUGGAGE'], ...overrides },
  })
  expect(res.status).toBe(201)
  return res.body.data.rack
}

async function createSlots(ctx, rackId, slots) {
  const res = await signedReq(app, 'post', `/racks/${rackId}/slots`, {
    token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { slots },
  })
  expect(res.status).toBe(201)
  return res.body.data.slots
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner13@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner13@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

// ═══════════════════════════════════════════════════════════════════════
describe('C0: RACK feature-flag gate', () => {
  test('RACK defaults false — /racks 403s until the platform admin enables it', async () => {
    const org = await onboardOrg(app, { platformToken, code: 'rack-flag', countryId, adminPhone: '9300000001' })
    const { token: adminToken } = await staffLogin(app, 'rack-flag', '9300000001', 'Admin@123')
    const deviceUuid = 'device-rack-flag'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const blockedRes = await signedReq(app, 'get', '/racks', { token: adminToken, deviceUuid, deviceSecret })
    expect(blockedRes.status).toBe(403)
    expect(blockedRes.body.code).toBe('FEATURE_DISABLED')

    await enableRack(org.organization._id)
    const okRes = await signedReq(app, 'get', '/racks', { token: adminToken, deviceUuid, deviceSecret })
    expect(okRes.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C1: Rack CRUD', () => {
  test('ORG_ADMIN creates a rack; a duplicate code at the same location is rejected', async () => {
    const ctx = await setUpOrg('rack-crud', '9300000011')
    const rack = await createRack(ctx)
    expect(rack.code).toBe('A')
    expect(rack.status).toBe('ACTIVE')

    const dupRes = await signedReq(app, 'post', '/racks', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, code: 'A', name: 'Duplicate' },
    })
    expect(dupRes.status).toBe(409)
  })

  test('a non-admin (staff) cannot create a rack', async () => {
    const ctx = await setUpOrg('rack-authz', '9300000021')
    const staffRes = await signedReq(app, 'post', '/staff', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { name: 'Staff', phone: '9300000029', password: 'Staff@123', role: 'STAFF' },
    })
    expect(staffRes.status).toBe(201)
    const { token: staffToken } = await staffLogin(app, 'rack-authz', '9300000029', 'Staff@123')

    const res = await signedReq(app, 'post', '/racks', {
      token: staffToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { locationId: ctx.locationId, code: 'A' },
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN_ROLE')
  })

  test('PATCH updates a rack and is audited', async () => {
    const ctx = await setUpOrg('rack-update', '9300000031')
    const rack = await createRack(ctx)

    const res = await signedReq(app, 'patch', `/racks/${rack._id}`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { name: 'Renamed', status: 'MAINTENANCE' },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.rack.name).toBe('Renamed')
    expect(res.body.data.rack.status).toBe('MAINTENANCE')

    const auditRes = await signedReq(app, 'get', '/audit-logs', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, query: { action: 'RACK_UPDATED' },
    })
    expect(auditRes.body.data.logs.length).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C2: Slot creation and listing', () => {
  test('bulk-creates slots; a duplicate slotCode within the same rack is rejected', async () => {
    const ctx = await setUpOrg('rack-slots', '9300000041')
    const rack = await createRack(ctx)
    const slots = await createSlots(ctx, rack._id, [{ slotCode: 'A01' }, { slotCode: 'A02', maxWeightKg: 10 }])
    expect(slots.length).toBe(2)
    expect(slots.every((s) => s.status === 'AVAILABLE')).toBe(true)

    const dupRes = await signedReq(app, 'post', `/racks/${rack._id}/slots`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { slots: [{ slotCode: 'A01' }] },
    })
    expect(dupRes.status).toBe(409)

    const listRes = await signedReq(app, 'get', `/racks/${rack._id}/slots`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, query: { status: 'AVAILABLE' },
    })
    expect(listRes.body.data.slots.length).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C3: Assign / release — shift-bound operational writes', () => {
  test('assign requires an active shift', async () => {
    const ctx = await setUpOrg('rack-noshift', '9300000051')
    const rack = await createRack(ctx)
    const [slot] = await createSlots(ctx, rack._id, [{ slotCode: 'A01' }])

    const staffRes = await signedReq(app, 'post', '/staff', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { name: 'NoShift', phone: '9300000059', password: 'Staff@123', role: 'STAFF' },
    })
    expect(staffRes.status).toBe(201)
    const { token: noShiftToken } = await staffLogin(app, 'rack-noshift', '9300000059', 'Staff@123')
    const noShiftDevice = 'device-rack-noshift-2'
    const noShiftSecret = await registerDevice(app, ctx.adminToken, noShiftDevice)

    const res = await signedReq(app, 'post', `/rack-slots/${slot._id}/assign`, {
      token: noShiftToken, deviceUuid: noShiftDevice, deviceSecret: noShiftSecret,
      body: { itemType: 'LUGGAGE', itemRef: 'LUG-000001' },
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('SHIFT_NOT_ACTIVE')
  })

  test('rejects an item type the slot does not allow', async () => {
    const ctx = await setUpOrg('rack-typemismatch', '9300000061')
    const rack = await createRack(ctx, { allowedItemTypes: ['PARCEL'] })
    const [slot] = await createSlots(ctx, rack._id, [{ slotCode: 'A01', allowedItemTypes: ['PARCEL'] }])

    const res = await signedReq(app, 'post', `/rack-slots/${slot._id}/assign`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { itemType: 'LUGGAGE', itemRef: 'LUG-000001' },
    })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('RACK_SLOT_ITEM_TYPE_MISMATCH')
  })

  test('assign then release happy path, with movement + audit history', async () => {
    const ctx = await setUpOrg('rack-assign', '9300000071')
    const rack = await createRack(ctx)
    const [slot] = await createSlots(ctx, rack._id, [{ slotCode: 'A01' }])

    const assignRes = await signedReq(app, 'post', `/rack-slots/${slot._id}/assign`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { itemType: 'LUGGAGE', itemRef: 'LUG-000001', reason: 'checked in' },
    })
    expect(assignRes.status).toBe(200)
    expect(assignRes.body.data.slot.status).toBe('OCCUPIED')
    expect(assignRes.body.data.slot.currentItemRef).toBe('LUG-000001')

    const reassignRes = await signedReq(app, 'post', `/rack-slots/${slot._id}/assign`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { itemType: 'LUGGAGE', itemRef: 'LUG-000002' },
    })
    expect(reassignRes.status).toBe(409)
    expect(reassignRes.body.code).toBe('RACK_SLOT_INVALID_STATUS')

    const releaseRes = await signedReq(app, 'post', `/rack-slots/${slot._id}/release`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { reason: 'picked up' },
    })
    expect(releaseRes.status).toBe(200)
    expect(releaseRes.body.data.slot.status).toBe('AVAILABLE')
    expect(releaseRes.body.data.slot.currentItemRef).toBeNull()

    const doubleReleaseRes = await signedReq(app, 'post', `/rack-slots/${slot._id}/release`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: {},
    })
    expect(doubleReleaseRes.status).toBe(409)

    const auditRes = await signedReq(app, 'get', '/audit-logs', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, query: { action: 'RACK_SLOT_ASSIGNED' },
    })
    expect(auditRes.body.data.logs.length).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C4: Manual status override — Manager+ only', () => {
  test('ORG_ADMIN can put a slot into MAINTENANCE with a reason; it then blocks assignment', async () => {
    const ctx = await setUpOrg('rack-maint', '9300000081')
    const rack = await createRack(ctx)
    const [slot] = await createSlots(ctx, rack._id, [{ slotCode: 'A01' }])

    const noReasonRes = await signedReq(app, 'patch', `/rack-slots/${slot._id}/status`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret, body: { status: 'MAINTENANCE' },
    })
    expect(noReasonRes.status).toBe(422)

    const statusRes = await signedReq(app, 'patch', `/rack-slots/${slot._id}/status`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { status: 'MAINTENANCE', reason: 'damaged shelf' },
    })
    expect(statusRes.status).toBe(200)
    expect(statusRes.body.data.slot.status).toBe('MAINTENANCE')

    const assignRes = await signedReq(app, 'post', `/rack-slots/${slot._id}/assign`, {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { itemType: 'LUGGAGE', itemRef: 'LUG-1' },
    })
    expect(assignRes.status).toBe(409)
  })

  test('a plain staff member cannot change slot status', async () => {
    const ctx = await setUpOrg('rack-maint-authz', '9300000091')
    const rack = await createRack(ctx)
    const [slot] = await createSlots(ctx, rack._id, [{ slotCode: 'A01' }])
    const staffRes = await signedReq(app, 'post', '/staff', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { name: 'Staff', phone: '9300000099', password: 'Staff@123', role: 'STAFF' },
    })
    expect(staffRes.status).toBe(201)
    const { token: staffToken } = await staffLogin(app, 'rack-maint-authz', '9300000099', 'Staff@123')

    const res = await signedReq(app, 'patch', `/rack-slots/${slot._id}/status`, {
      token: staffToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      body: { status: 'BLOCKED', reason: 'x' },
    })
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C5: Smart slot suggestion (§6) — not just the first available slot', () => {
  test('suggests the best-fit slot by weight/size/security, and 404s when nothing fits', async () => {
    const ctx = await setUpOrg('rack-suggest', '9300000101')
    const rack = await createRack(ctx, { allowedItemTypes: [] })
    await createSlots(ctx, rack._id, [
      { slotCode: 'BIG', maxWeightKg: 50, dimensions: { lengthCm: 100, widthCm: 100, heightCm: 100 }, securityLevel: 'STANDARD' },
      { slotCode: 'SMALL', maxWeightKg: 5, dimensions: { lengthCm: 20, widthCm: 20, heightCm: 20 }, securityLevel: 'STANDARD' },
      { slotCode: 'SECURE', maxWeightKg: 50, dimensions: { lengthCm: 100, widthCm: 100, heightCm: 100 }, securityLevel: 'HIGH' },
    ])

    const fitRes = await signedReq(app, 'get', '/rack-slots/suggest', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      query: { locationId: ctx.locationId, itemType: 'LUGGAGE', weightKg: '3', lengthCm: '10', widthCm: '10', heightCm: '10' },
    })
    expect(fitRes.status).toBe(200)
    expect(fitRes.body.data.slot.slotCode).toBe('SMALL')

    const secureRes = await signedReq(app, 'get', '/rack-slots/suggest', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      query: { locationId: ctx.locationId, itemType: 'PARCEL', securityLevel: 'HIGH' },
    })
    expect(secureRes.body.data.slot.slotCode).toBe('SECURE')

    const noneRes = await signedReq(app, 'get', '/rack-slots/suggest', {
      token: ctx.adminToken, deviceUuid: ctx.deviceUuid, deviceSecret: ctx.deviceSecret,
      query: { locationId: ctx.locationId, itemType: 'LUGGAGE', weightKg: '9999' },
    })
    expect(noneRes.status).toBe(404)
    expect(noneRes.body.code).toBe('NO_SLOT_AVAILABLE')
  })
})
