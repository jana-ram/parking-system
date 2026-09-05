/**
 * Coverage for GET /search — one query box across Vehicle/QrToken sessions,
 * Luggage orders, Parcel orders, Staff, and transaction IDs across all three
 * payment ledgers (§ platform brief: "one search should search across all
 * types... if the search matches multiple types, show all matching results
 * together"). Open to any authenticated role, same as the existing
 * /sessions/search.
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
  await PlatformAdmin.create({ name: 'Owner', email: 'owner24@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner24@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

describe('GET /search', () => {
  test('finds a vehicle session by a partial plate number', async () => {
    const code = 'search-vehicle'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9910000001' })
    const { token: adminToken } = await staffLogin(app, code, '9910000001', 'Admin@123')
    const deviceUuid = `device-${code}`
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const locRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: 'Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
    })
    const locationId = locRes.body.data.location._id
    const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
    const vehicleTypeId = vtRes.body.data.vehicleType._id
    await signedReq(app, 'post', '/pricing-rules', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { locationId, vehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Flat', config: { flatAmountMinor: 1000 } },
    })
    await signedReq(app, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
    const tokenRes = await signedReq(app, 'post', '/tokens/batches', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, batchSize: 1 } })
    const tokenCode = tokenRes.body.data.tokens[0].tokenCode
    await signedReq(app, 'post', '/sessions/entry', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-search-veh', locationId, vehicleNumber: 'KA05SR9999', vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })

    const res = await signedReq(app, 'get', '/search', { token: adminToken, deviceUuid, deviceSecret, query: { q: 'sr99' } })
    expect(res.status).toBe(200)
    expect(res.body.data.counts.vehicles).toBe(1)
    expect(res.body.data.vehicles[0].vehicleNumber).toBe('KA05SR9999')
  });

  test('a Staff (non-Manager) account can search too', async () => {
    const code = 'search-staff-role'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9910000002' })
    const { token: adminToken } = await staffLogin(app, code, '9910000002', 'Admin@123')
    const deviceUuid = `device-${code}`
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)
    const createStaffRes = await signedReq(app, 'post', '/staff', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { name: 'Plain Staff', phone: '9910000009', password: 'Staff@123', role: 'STAFF' },
    })
    expect(createStaffRes.status).toBe(201)
    const { token: staffToken } = await staffLogin(app, code, '9910000009', 'Staff@123')

    const res = await signedReq(app, 'get', '/search', { token: staffToken, deviceUuid, deviceSecret, query: { q: 'anything' } })
    expect(res.status).toBe(200)
  });

  test('finds a luggage order by order code, customer name, and phone; a parcel order by receiver phone; and a transaction by clientTransactionId', async () => {
    const code = 'search-multi'
    const org = await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9910000003' })
    await enableModules(org.organization._id, { LUGGAGE: true, PARCEL: true })
    const { token: adminToken } = await staffLogin(app, code, '9910000003', 'Admin@123')
    const deviceUuid = `device-${code}`
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)
    const locRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: 'Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
    })
    const locationId = locRes.body.data.location._id
    await signedReq(app, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })

    const luggageRes = await signedReq(app, 'post', '/luggage-orders', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { locationId, customerName: 'Priya Search', customerPhone: '9822233344', ratePerDayMinor: 5000 },
    })
    const luggageOrderId = luggageRes.body.data.order._id
    const luggageOrderCode = luggageRes.body.data.order.orderCode

    const parcelRes = await signedReq(app, 'post', '/parcel-orders', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { locationId, senderName: 'Sam Sender', receiverName: 'Riya Receiver', receiverPhone: '9833344455', ratePerDayMinor: 3000 },
    })
    expect(parcelRes.status).toBe(201)

    await signedReq(app, 'post', `/luggage-orders/${luggageOrderId}/payment`, {
      token: adminToken, deviceUuid, deviceSecret, body: { method: 'CASH', amountMinor: 5000, clientTransactionId: 'ctx-search-luggage-pay-1' },
    })

    // By order code
    const byCode = await signedReq(app, 'get', '/search', { token: adminToken, deviceUuid, deviceSecret, query: { q: luggageOrderCode } })
    expect(byCode.body.data.counts.luggage).toBe(1)
    expect(byCode.body.data.luggage[0].customerName).toBe('Priya Search')

    // By customer name
    const byName = await signedReq(app, 'get', '/search', { token: adminToken, deviceUuid, deviceSecret, query: { q: 'priya' } })
    expect(byName.body.data.counts.luggage).toBe(1)

    // By customer phone (partial)
    const byPhone = await signedReq(app, 'get', '/search', { token: adminToken, deviceUuid, deviceSecret, query: { q: '822233' } })
    expect(byPhone.body.data.counts.luggage).toBe(1)

    // By parcel receiver phone
    const byReceiverPhone = await signedReq(app, 'get', '/search', { token: adminToken, deviceUuid, deviceSecret, query: { q: '833344455' } })
    expect(byReceiverPhone.body.data.counts.parcel).toBe(1)
    expect(byReceiverPhone.body.data.parcel[0].receiverName).toBe('Riya Receiver')

    // By transaction id
    const byTxn = await signedReq(app, 'get', '/search', { token: adminToken, deviceUuid, deviceSecret, query: { q: 'ctx-search-luggage-pay-1' } })
    expect(byTxn.body.data.counts.transactions).toBe(1)
    expect(byTxn.body.data.transactions[0].module).toBe('LUGGAGE')
    expect(byTxn.body.data.transactions[0].amountMinor).toBe(5000)
  });

  test('a query matching nothing returns zero counts across every type, not an error', async () => {
    const code = 'search-nomatch'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9910000004' })
    const { token: adminToken } = await staffLogin(app, code, '9910000004', 'Admin@123')
    const deviceUuid = `device-${code}`
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const res = await signedReq(app, 'get', '/search', { token: adminToken, deviceUuid, deviceSecret, query: { q: 'zzz-nothing-matches-zzz' } })
    expect(res.status).toBe(200)
    expect(res.body.data.totalCount).toBe(0)
  });

  test('rejects an empty query', async () => {
    const code = 'search-empty'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9910000005' })
    const { token: adminToken } = await staffLogin(app, code, '9910000005', 'Admin@123')
    const deviceUuid = `device-${code}`
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const res = await signedReq(app, 'get', '/search', { token: adminToken, deviceUuid, deviceSecret, query: { q: '  ' } })
    expect(res.status).toBe(422)
  });
});
