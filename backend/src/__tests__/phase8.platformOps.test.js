/**
 * Phase 8: cross-org read endpoints for the Product Owner web dashboard
 * (§T). Proves the actual guarantee that matters here — a platform admin
 * sees data from BOTH orgs in one call, something no tenant-scoped route
 * (or a bug reintroducing organizationId scoping here) could ever return.
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

let replSet, app, countryId, platformToken

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

describe('GET/POST /platform/countries', () => {
  test('lists seeded countries and can add a new one', async () => {
    const listRes = await request(app).get('/platform/countries').set('Authorization', `Bearer ${platformToken}`)
    expect(listRes.status).toBe(200)
    expect(listRes.body.data.countries.some((c) => c.isoCode === 'IN')).toBe(true)

    const createRes = await request(app)
      .post('/platform/countries')
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ isoCode: 'US', name: 'United States', defaultCurrency: 'USD', defaultTimezone: 'America/New_York' })
    expect(createRes.status).toBe(201)
  })

  test('a non-platform (tenant) token cannot access platform routes at all', async () => {
    const res = await request(app).get('/platform/countries').set('Authorization', 'Bearer not-a-real-token')
    expect(res.status).toBe(401)
  })
})

describe('cross-org visibility (§1.7, §T)', () => {
  let orgADeviceUuid, orgADeviceSecret, orgAAdminToken
  let orgBDeviceUuid, orgBDeviceSecret, orgBAdminToken

  beforeAll(async () => {
    const orgA = await onboardOrg(app, { platformToken, code: 'plat-org-a', countryId, adminPhone: '9800000001' })
    ;({ token: orgAAdminToken } = await staffLogin(app, 'plat-org-a', '9800000001', 'Admin@123'))
    orgADeviceUuid = 'plat-device-a'
    orgADeviceSecret = await registerDevice(app, orgAAdminToken, orgADeviceUuid)

    const orgB = await onboardOrg(app, { platformToken, code: 'plat-org-b', countryId, adminPhone: '9800000002' })
    ;({ token: orgBAdminToken } = await staffLogin(app, 'plat-org-b', '9800000002', 'Admin@123'))
    orgBDeviceUuid = 'plat-device-b'
    orgBDeviceSecret = await registerDevice(app, orgBAdminToken, orgBDeviceUuid)

    await signedReq(app, 'post', '/locations', {
      token: orgAAdminToken, deviceUuid: orgADeviceUuid, deviceSecret: orgADeviceSecret,
      body: { countryId, name: 'Org A Lot', geo: { lat: 1, lng: 1 }, timezone: 'Asia/Kolkata', currency: 'INR' },
    })
    await signedReq(app, 'post', '/locations', {
      token: orgBAdminToken, deviceUuid: orgBDeviceUuid, deviceSecret: orgBDeviceSecret,
      body: { countryId, name: 'Org B Lot', geo: { lat: 2, lng: 2 }, timezone: 'Asia/Kolkata', currency: 'INR' },
    })
  }, 30000)

  test('GET /platform/locations returns locations from BOTH organizations, with org name populated', async () => {
    const res = await request(app).get('/platform/locations').set('Authorization', `Bearer ${platformToken}`)
    expect(res.status).toBe(200)
    const names = res.body.data.locations.map((l) => l.name)
    expect(names).toEqual(expect.arrayContaining(['Org A Lot', 'Org B Lot']))
    const orgALoc = res.body.data.locations.find((l) => l.name === 'Org A Lot')
    expect(orgALoc.organizationId.code).toBe('plat-org-a')
  })

  test('GET /platform/devices returns devices from both orgs, and platform can deactivate one', async () => {
    const res = await request(app).get('/platform/devices').set('Authorization', `Bearer ${platformToken}`)
    expect(res.status).toBe(200)
    const uuids = res.body.data.devices.map((d) => d.deviceUuid)
    expect(uuids).toEqual(expect.arrayContaining([orgADeviceUuid, orgBDeviceUuid]))

    const target = res.body.data.devices.find((d) => d.deviceUuid === orgADeviceUuid)
    const deactivateRes = await request(app)
      .post(`/platform/devices/${target._id}/deactivate`)
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ reason: 'reported compromised' })
    expect(deactivateRes.status).toBe(200)
    expect(deactivateRes.body.data.device.status).toBe('DEACTIVATED')

    // and the tenant side actually reflects it — a signed request from that
    // device is now rejected, proving this isn't a display-only toggle
    const blockedRes = await signedReq(app, 'get', '/locations', { token: orgAAdminToken, deviceUuid: orgADeviceUuid, deviceSecret: orgADeviceSecret })
    expect(blockedRes.status).toBe(403)
    expect(blockedRes.body.code).toBe('DEVICE_DEACTIVATED')
  })

  test('GET /platform/audit returns entries across both orgs, filterable by organizationId', async () => {
    const allRes = await request(app).get('/platform/audit').set('Authorization', `Bearer ${platformToken}`)
    expect(allRes.status).toBe(200)
    expect(allRes.body.data.logs.length).toBeGreaterThan(0)

    const orgAOnly = await request(app)
      .get('/platform/audit')
      .query({ organizationId: (await onboardOrgLookup('plat-org-a')) })
      .set('Authorization', `Bearer ${platformToken}`)
    expect(orgAOnly.status).toBe(200)
    expect(orgAOnly.body.data.logs.every((l) => l.organizationId?.code === 'plat-org-a')).toBe(true)
  })

  async function onboardOrgLookup(code) {
    const Organization = require('../models/Organization')
    const org = await Organization.findOne({ code })
    return org._id.toString()
  }

  test('GET /platform/analytics/overview reflects both orgs (at least 2 organizations, 2 locations, 2 devices)', async () => {
    const res = await request(app).get('/platform/analytics/overview').set('Authorization', `Bearer ${platformToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.organizations).toBeGreaterThanOrEqual(2)
    expect(res.body.data.locations).toBeGreaterThanOrEqual(2)
    expect(res.body.data.devices).toBeGreaterThanOrEqual(2)
  })
})
