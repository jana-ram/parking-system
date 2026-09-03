/**
 * Coverage for the tenant feature-module system (§2 of the platform brief):
 * Organization.modules, requireFeature.middleware.js, the Platform Admin
 * PATCH/GET module-management routes, and the boot-time backfill. Same
 * black-box Supertest-against-real-app-plus-in-memory-replica-set style as
 * phase11.locationFeatures.test.js.
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

// Builds a fully working org (location + vehicle type + pricing rule + staff
// + open shift) so PARKING-gated route tests have something real to hit.
async function setUpOrg(code, adminPhone) {
  const org = await onboardOrg(app, { platformToken, code, countryId, adminPhone })
  const orgId = org.organization._id
  const { token: adminToken } = await staffLogin(app, code, adminPhone, 'Admin@123')
  const deviceUuid = `device-${code}`
  const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

  const locRes = await signedReq(app, 'post', '/locations', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { countryId, name: `${code} Lot`, geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
  })
  expect(locRes.status).toBe(201)
  const locationId = locRes.body.data.location._id

  const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
  expect(vtRes.status).toBe(201)
  const vehicleTypeId = vtRes.body.data.vehicleType._id

  const ruleRes = await signedReq(app, 'post', '/pricing-rules', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { locationId, vehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Car flat', config: { flatAmountMinor: 10000 } },
  })
  expect(ruleRes.status).toBe(201)

  const staffRes = await signedReq(app, 'post', '/staff', {
    token: adminToken, deviceUuid, deviceSecret,
    body: { name: 'Staff', phone: `${adminPhone.slice(0, -1)}9`, password: 'Staff@123', role: 'STAFF' },
  })
  expect(staffRes.status).toBe(201)
  const { token: staffToken } = await staffLogin(app, code, `${adminPhone.slice(0, -1)}9`, 'Staff@123')

  const shiftRes = await signedReq(app, 'post', '/shifts/start', {
    token: staffToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 },
  })
  expect(shiftRes.status).toBe(201)

  return { orgId, adminToken, staffToken, deviceUuid, deviceSecret, locationId, vehicleTypeId }
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner12@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner12@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

// ═══════════════════════════════════════════════════════════════════════
describe('C0: defaults on a freshly onboarded organization', () => {
  test('PARKING and REPORTS default true; everything else defaults false', async () => {
    const { adminToken, deviceUuid, deviceSecret } = await setUpOrg('feat-defaults', '9200000001')
    const res = await signedReq(app, 'get', '/orgs/me', { token: adminToken, deviceUuid, deviceSecret })
    expect(res.status).toBe(200)
    expect(res.body.data.organization.modules).toMatchObject({
      PARKING: true, REPORTS: true, RACK: false, LUGGAGE: false, PARCEL: false,
      BILLING: false, NOTIFICATIONS: false, CUSTOMER_SELF_SERVICE: false, AI_ASSISTANT: false,
    })
  })

  test('GET /platform/modules returns the full registry', async () => {
    const res = await request(app).get('/platform/modules').set('Authorization', `Bearer ${platformToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.keys).toEqual(
      expect.arrayContaining(['PARKING', 'RACK', 'LUGGAGE', 'PARCEL', 'BILLING', 'REPORTS', 'NOTIFICATIONS', 'CUSTOMER_SELF_SERVICE', 'AI_ASSISTANT']),
    )
    expect(res.body.data.labels.RACK).toBe('Rack Management')
  })

  test('the boot-time backfill sets PARKING on a doc written before the modules field existed', async () => {
    const Organization = require('../models/Organization')
    const StaffUser = require('../models/StaffUser')
    const { backfillOrgModuleDefaults } = require('../utils/seed')

    const legacyOrg = (await Organization.create([{ name: 'Legacy Co', code: 'legacy-co', countryId, defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' }]))[0]
    // Simulate a pre-migration document by stripping the field directly at the
    // driver level (bypassing schema defaults). Asserted at the raw-collection
    // level too, since Mongoose applies schema defaults on hydration even for
    // a doc missing the field in storage — the Organization.findById() view
    // would mask the very gap this migration exists to close.
    const rawCollection = mongoose.connection.collection('organizations')
    await rawCollection.updateOne({ _id: legacyOrg._id }, { $unset: { modules: '' } })
    const rawBefore = await rawCollection.findOne({ _id: legacyOrg._id })
    expect(rawBefore.modules).toBeUndefined()

    await backfillOrgModuleDefaults()

    const rawAfter = await rawCollection.findOne({ _id: legacyOrg._id })
    expect(rawAfter.modules.PARKING).toBe(true)
    expect(rawAfter.modules.REPORTS).toBe(true)

    const after = await Organization.findById(legacyOrg._id)
    expect(after.modules.PARKING).toBe(true)

    await StaffUser.deleteMany({ organizationId: legacyOrg._id })
    await Organization.findByIdAndDelete(legacyOrg._id)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C1: PATCH /platform/organizations/:id/modules', () => {
  test('a non-platform-admin (tenant staff token) cannot call the platform route', async () => {
    const { orgId, adminToken } = await setUpOrg('feat-authz', '9200000011')
    const res = await request(app).patch(`/platform/organizations/${orgId}/modules`).set('Authorization', `Bearer ${adminToken}`).send({ RACK: true })
    expect(res.status).toBe(401)
  })

  test('an unknown module key is rejected by the locked schema', async () => {
    const { orgId } = await setUpOrg('feat-unknown', '9200000021')
    const res = await request(app).patch(`/platform/organizations/${orgId}/modules`).set('Authorization', `Bearer ${platformToken}`).send({ NOT_A_REAL_MODULE: true })
    expect(res.status).toBe(422)
  })

  test('an empty body is rejected (min 1 key)', async () => {
    const { orgId } = await setUpOrg('feat-empty', '9200000031')
    const res = await request(app).patch(`/platform/organizations/${orgId}/modules`).set('Authorization', `Bearer ${platformToken}`).send({})
    expect(res.status).toBe(422)
  })

  test('flipping RACK on merges — it does NOT reset PARKING or REPORTS', async () => {
    const { orgId, adminToken, deviceUuid, deviceSecret } = await setUpOrg('feat-merge', '9200000041')
    const patchRes = await request(app).patch(`/platform/organizations/${orgId}/modules`).set('Authorization', `Bearer ${platformToken}`).send({ RACK: true })
    expect(patchRes.status).toBe(200)
    expect(patchRes.body.data.organization.modules).toMatchObject({ RACK: true, PARKING: true, REPORTS: true })

    const meRes = await signedReq(app, 'get', '/orgs/me', { token: adminToken, deviceUuid, deviceSecret })
    expect(meRes.body.data.organization.modules).toMatchObject({ RACK: true, PARKING: true, REPORTS: true })

    const auditRes = await signedReq(app, 'get', '/audit-logs', { token: adminToken, deviceUuid, deviceSecret, query: { action: 'PLATFORM_ORG_MODULES_CHANGED' } })
    expect(auditRes.status).toBe(200)
    expect(auditRes.body.data.logs.length).toBe(1)
    expect(auditRes.body.data.logs[0].oldValue.RACK).toBe(false)
    expect(auditRes.body.data.logs[0].newValue.RACK).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C2: requireFeature enforcement on real PARKING-gated routes', () => {
  test('disabling PARKING blocks entry, token, vehicle-type and parking-area routes with 403 FEATURE_DISABLED', async () => {
    const { orgId, adminToken, staffToken, deviceUuid, deviceSecret, locationId, vehicleTypeId } = await setUpOrg('feat-parking-off', '9200000051')

    const patchRes = await request(app).patch(`/platform/organizations/${orgId}/modules`).set('Authorization', `Bearer ${platformToken}`).send({ PARKING: false })
    expect(patchRes.status).toBe(200)

    const tokenBatchRes = await signedReq(app, 'post', '/tokens/batches', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, batchSize: 1 } })
    expect(tokenBatchRes.status).toBe(403)
    expect(tokenBatchRes.body.code).toBe('FEATURE_DISABLED')

    const listVtRes = await signedReq(app, 'get', '/vehicle-types', { token: staffToken, deviceUuid, deviceSecret })
    expect(listVtRes.status).toBe(403)
    expect(listVtRes.body.code).toBe('FEATURE_DISABLED')

    const listAreaRes = await signedReq(app, 'get', '/parking-areas', { token: staffToken, deviceUuid, deviceSecret })
    expect(listAreaRes.status).toBe(403)
    expect(listAreaRes.body.code).toBe('FEATURE_DISABLED')

    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: staffToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-feat-off-1', locationId, vehicleNumber: 'FEATOFF01', vehicleTypeId, tokenCode: 'DOES-NOT-MATTER', locationCheck: goodLocationCheck() },
    })
    expect(entryRes.status).toBe(403)
    expect(entryRes.body.code).toBe('FEATURE_DISABLED')

    // Re-enabling restores normal behavior — the gate is live, not a one-way trip.
    const reEnableRes = await request(app).patch(`/platform/organizations/${orgId}/modules`).set('Authorization', `Bearer ${platformToken}`).send({ PARKING: true })
    expect(reEnableRes.status).toBe(200)
    const listAreaAgainRes = await signedReq(app, 'get', '/parking-areas', { token: staffToken, deviceUuid, deviceSecret })
    expect(listAreaAgainRes.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('C3: requireFeature enforcement on REPORTS-gated routes', () => {
  test('REPORTS defaults on; disabling it blocks /reports with 403 FEATURE_DISABLED', async () => {
    const { orgId, adminToken, deviceUuid, deviceSecret } = await setUpOrg('feat-reports', '9200000061')

    const okRes = await signedReq(app, 'get', '/reports/summary', {
      token: adminToken, deviceUuid, deviceSecret, query: { from: '2020-01-01', to: '2030-01-01' },
    })
    expect(okRes.status).toBe(200)

    const patchRes = await request(app).patch(`/platform/organizations/${orgId}/modules`).set('Authorization', `Bearer ${platformToken}`).send({ REPORTS: false })
    expect(patchRes.status).toBe(200)

    const blockedRes = await signedReq(app, 'get', '/reports/summary', {
      token: adminToken, deviceUuid, deviceSecret, query: { from: '2020-01-01', to: '2030-01-01' },
    })
    expect(blockedRes.status).toBe(403)
    expect(blockedRes.body.code).toBe('FEATURE_DISABLED')
  })
})
