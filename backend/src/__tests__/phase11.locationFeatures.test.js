/**
 * Coverage for the three new configurable per-location features: exit
 * discount (§B1), fixed-entry/no-exit (§B2), and parking-area/slot
 * assignment (§B3) — see the plan doc's "Smart Parking — Responsiveness
 * Overhaul + 3 Configurable Location Features". Same black-box
 * Supertest-against-real-app-plus-in-memory-replica-set style as
 * phase3.entryExitFlow.test.js.
 */
const crypto = require('crypto')

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret'
process.env.JWT_EXPIRE = '1h'
process.env.PLATFORM_JWT_SECRET = 'test-platform-jwt-secret'
process.env.DEVICE_SECRET_ENC_KEY = crypto.randomBytes(32).toString('hex')

const { MongoMemoryReplSet } = require('mongodb-memory-server')
const mongoose = require('mongoose')
const { signedReq, platformLogin, onboardOrg, staffLogin, registerDevice } = require('./testUtils')

let replSet
let app
let countryId

const orgCode = 'feature-co'
let adminToken, staffToken
const deviceUuid = 'shared-device-1'
let deviceSecret
let locationId
let carVehicleTypeId, templeCarVehicleTypeId
let shiftInstanceId

const GOOD_GEO = { lat: 12.9716, lng: 77.5946 }
function goodLocationCheck(overrides = {}) {
  return { lat: GOOD_GEO.lat, lng: GOOD_GEO.lng, accuracyM: 10, mockDetected: false, ...overrides }
}

async function provisionOneToken(locId) {
  const res = await signedReq(app, 'post', '/tokens/batches', {
    token: adminToken, deviceUuid, deviceSecret, body: { locationId: locId, batchSize: 1 },
  })
  expect(res.status).toBe(201)
  return res.body.data.tokens[0].tokenCode
}

async function enterAndReachPaymentPending({ vehicleTypeId, vehicleNumber, clientTransactionId }) {
  const tokenCode = await provisionOneToken(locationId)
  const res = await signedReq(app, 'post', '/sessions/entry', {
    token: staffToken, deviceUuid, deviceSecret,
    body: { clientTransactionId, locationId, vehicleNumber, vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
  })
  expect(res.status).toBe(201)
  expect(res.body.data.status).toBe('PAYMENT_PENDING')
  return { sessionId: res.body.data.sessionId, tokenCode, amountDueMinor: res.body.data.amountDueMinor }
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner11@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()

  const platformToken = await platformLogin(app, 'owner11@test.com', 'Owner@123')
  await onboardOrg(app, { platformToken, code: orgCode, countryId, adminPhone: '9100000001' })
  ;({ token: adminToken } = await staffLogin(app, orgCode, '9100000001', 'Admin@123'))
  deviceSecret = await registerDevice(app, adminToken, deviceUuid)

  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: 'Feature Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
  })
  expect(locRes.status).toBe(201)
  locationId = locRes.body.data.location._id

  const carRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
  carVehicleTypeId = carRes.body.data.vehicleType._id
  const templeCarRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'TCAR', name: 'Temple Car' } })
  templeCarVehicleTypeId = templeCarRes.body.data.vehicleType._id

  // CAR = PAY_ON_EXIT hourly, so entry lands at PAYMENT_PENDING only via exit
  // — for discount tests we want PAYMENT_PENDING reachable right at entry,
  // so use PAY_ON_ENTRY flat pricing for the discount vehicle type instead.
  const carRule = await signedReq(app, 'post', '/pricing-rules', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { locationId, vehicleTypeId: carVehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Car flat', config: { flatAmountMinor: 10000 } },
  })
  expect(carRule.status).toBe(201)

  const templeCarRule = await signedReq(app, 'post', '/pricing-rules', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { locationId, vehicleTypeId: templeCarVehicleTypeId, mode: 'FIXED_DURATION', name: 'Temple car flat', config: { flatAmountMinor: 5000 } },
  })
  expect(templeCarRule.status).toBe(201)

  const staffRes = await signedReq(app, 'post', '/staff', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { name: 'Staff Sam', phone: '9100000003', password: 'Staff@123', role: 'STAFF' },
  })
  expect(staffRes.status).toBe(201)
  ;({ token: staffToken } = await staffLogin(app, orgCode, '9100000003', 'Staff@123'))

  const shiftRes = await signedReq(app, 'post', '/shifts/start', {
    token: staffToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 },
  })
  expect(shiftRes.status).toBe(201)
  shiftInstanceId = shiftRes.body.data.shiftInstance._id
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

// ═══════════════════════════════════════════════════════════════════════
describe('B0: Location.features toggles via PATCH /locations/:id', () => {
  test('features default to all-disabled on a freshly created location', async () => {
    const res = await signedReq(app, 'get', '/locations', { token: staffToken, deviceUuid, deviceSecret })
    const loc = res.body.data.locations.find((l) => l._id === locationId)
    expect(loc.features.exitDiscount.enabled).toBe(false)
    expect(loc.features.fixedEntryNoExit.enabled).toBe(false)
    expect(loc.features.slotAssignment.enabled).toBe(false)
  })

  test('non-admin staff cannot patch location features', async () => {
    const res = await signedReq(app, 'patch', `/locations/${locationId}`, {
      token: staffToken, deviceUuid, deviceSecret, body: { features: { exitDiscount: { enabled: true } } },
    })
    expect(res.status).toBe(403)
  })

  test('an unknown feature key is rejected by the locked schema', async () => {
    const res = await signedReq(app, 'patch', `/locations/${locationId}`, {
      token: adminToken, deviceUuid, deviceSecret, body: { features: { notARealFeature: { enabled: true } } },
    })
    expect(res.status).toBe(422)
  })

  test('ORG_ADMIN can enable exitDiscount and fixedEntryNoExit', async () => {
    const res = await signedReq(app, 'patch', `/locations/${locationId}`, {
      token: adminToken, deviceUuid, deviceSecret,
      body: { features: { exitDiscount: { enabled: true }, fixedEntryNoExit: { enabled: true }, slotAssignment: { enabled: true } } },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.location.features.exitDiscount.enabled).toBe(true)
    expect(res.body.data.location.features.fixedEntryNoExit.enabled).toBe(true)
    expect(res.body.data.location.features.slotAssignment.enabled).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('B1: exit discount at payment time', () => {
  test('a discount over the remaining amount due is rejected (422)', async () => {
    const { sessionId, amountDueMinor } = await enterAndReachPaymentPending({
      vehicleTypeId: carVehicleTypeId, vehicleNumber: 'DISC0001', clientTransactionId: 'ctx-disc-1',
    })
    const res = await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-disc-pay-1', method: 'CASH', amountMinor: 0, discountMinor: amountDueMinor + 1 },
    })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('VALIDATION_ERROR')
  })

  test('a discount with no reason is rejected by validation', async () => {
    const { sessionId } = await enterAndReachPaymentPending({
      vehicleTypeId: carVehicleTypeId, vehicleNumber: 'DISC0002', clientTransactionId: 'ctx-disc-2',
    })
    const res = await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-disc-pay-2', method: 'CASH', amountMinor: 5000, discountMinor: 5000 },
    })
    expect(res.status).toBe(422)
  })

  test('a full discount (free parking) with a reason completes the session collecting Rs0 cash', async () => {
    const { sessionId, amountDueMinor } = await enterAndReachPaymentPending({
      vehicleTypeId: carVehicleTypeId, vehicleNumber: 'DISC0003', clientTransactionId: 'ctx-disc-3',
    })
    const res = await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-disc-pay-3', method: 'CASH', amountMinor: 0, discountMinor: amountDueMinor, discountReason: 'Shop purchase — free parking' },
    })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('PAID')
    expect(res.body.data.discountMinor).toBe(amountDueMinor)
    expect(res.body.data.sessionStatus).toBe('ACTIVE') // PAY_ON_ENTRY: PAID -> ACTIVE, not COMPLETED
  })

  test('discount is rejected (403) at a location where exitDiscount is disabled', async () => {
    const otherLocRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: 'No Discount Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR' },
    })
    const otherLocationId = otherLocRes.body.data.location._id
    const ruleRes = await signedReq(app, 'post', '/pricing-rules', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { locationId: otherLocationId, vehicleTypeId: carVehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Car flat 2', config: { flatAmountMinor: 3000 } },
    })
    expect(ruleRes.status).toBe(201)
    const tokenCode = await provisionOneToken(otherLocationId)
    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-disc-nofeat-1', locationId: otherLocationId, vehicleNumber: 'NODISC001', vehicleTypeId: carVehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    expect(entryRes.status).toBe(201)

    const payRes = await signedReq(app, 'post', `/sessions/${entryRes.body.data.sessionId}/payment`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-disc-nofeat-pay-1', method: 'CASH', amountMinor: 2000, discountMinor: 1000, discountReason: 'test' },
    })
    expect(payRes.status).toBe(403)
    expect(payRes.body.code).toBe('FEATURE_DISABLED')
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('B2: fixed-entry/no-exit sessions', () => {
  test('a FIXED_DURATION entry at a fixedEntryNoExit-enabled location sets exitRequired:false', async () => {
    const tokenCode = await provisionOneToken(locationId)
    const res = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-noexit-1', locationId, vehicleNumber: 'NOEXIT001', vehicleTypeId: templeCarVehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    expect(res.status).toBe(201)
    expect(res.body.data.exitRequired).toBe(false)
  })

  test('a regular PAY_ON_ENTRY session at the same (flagged) location still sets exitRequired:true', async () => {
    const tokenCode = await provisionOneToken(locationId)
    const res = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-noexit-2', locationId, vehicleNumber: 'NOEXIT002', vehicleTypeId: carVehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    expect(res.status).toBe(201)
    expect(res.body.data.exitRequired).toBe(true)
  })

  test('an exitRequired:false session can still optionally be scanned out — the exit scan is not blocked', async () => {
    const tokenCode = await provisionOneToken(locationId)
    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-noexit-3', locationId, vehicleNumber: 'NOEXIT003', vehicleTypeId: templeCarVehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    expect(entryRes.body.data.status).toBe('PAYMENT_PENDING')

    const payRes = await signedReq(app, 'post', `/sessions/${entryRes.body.data.sessionId}/payment`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-noexit-3-pay', method: 'CASH', amountMinor: entryRes.body.data.amountDueMinor },
    })
    expect(payRes.body.data.sessionStatus).toBe('ACTIVE') // paid in full at entry, FIXED_DURATION

    const exitRes = await signedReq(app, 'post', `/sessions/${entryRes.body.data.sessionId}/exit/request`, {
      token: staffToken, deviceUuid, deviceSecret,
      body: { tokenCode, exitAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), locationCheck: goodLocationCheck() },
    })
    expect(exitRes.status).toBe(200)
    expect(exitRes.body.data.status).toBe('COMPLETED')
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('B3: parking areas / slots RBAC + entry-time assignment', () => {
  let areaId

  test('staff can list parking areas (empty) but cannot create one', async () => {
    const listRes = await signedReq(app, 'get', '/parking-areas', { token: staffToken, deviceUuid, deviceSecret, query: { locationId } })
    expect(listRes.status).toBe(200)
    expect(listRes.body.data.parkingAreas).toEqual([])

    const createRes = await signedReq(app, 'post', '/parking-areas', {
      token: staffToken, deviceUuid, deviceSecret, body: { locationId, name: 'North Lot' },
    })
    expect(createRes.status).toBe(403)
  })

  test('ORG_ADMIN can create a parking area and bulk-create slots', async () => {
    const areaRes = await signedReq(app, 'post', '/parking-areas', {
      token: adminToken, deviceUuid, deviceSecret, body: { locationId, name: 'North Lot', capacity: 2 },
    })
    expect(areaRes.status).toBe(201)
    areaId = areaRes.body.data.parkingArea._id

    const slotsRes = await signedReq(app, 'post', `/parking-areas/${areaId}/slots`, {
      token: adminToken, deviceUuid, deviceSecret, body: { slotNumbers: ['A1', 'A2'] },
    })
    expect(slotsRes.status).toBe(201)
    expect(slotsRes.body.data.slots).toHaveLength(2)
  })

  test('staff can list AVAILABLE slots and assign one at entry; the slot flips to OCCUPIED', async () => {
    const slotsRes = await signedReq(app, 'get', `/parking-areas/${areaId}/slots`, {
      token: staffToken, deviceUuid, deviceSecret, query: { status: 'AVAILABLE' },
    })
    expect(slotsRes.status).toBe(200)
    expect(slotsRes.body.data.slots).toHaveLength(2)
    const slotId = slotsRes.body.data.slots[0]._id

    const tokenCode = await provisionOneToken(locationId)
    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: {
        clientTransactionId: 'ctx-slot-1', locationId, slotId, vehicleNumber: 'SLOT0001', vehicleTypeId: carVehicleTypeId, tokenCode,
        locationCheck: goodLocationCheck(),
      },
    })
    expect(entryRes.status).toBe(201)

    const afterRes = await signedReq(app, 'get', `/parking-areas/${areaId}/slots`, { token: staffToken, deviceUuid, deviceSecret })
    const assigned = afterRes.body.data.slots.find((s) => s._id === slotId)
    expect(assigned.status).toBe('OCCUPIED')
  })
})
