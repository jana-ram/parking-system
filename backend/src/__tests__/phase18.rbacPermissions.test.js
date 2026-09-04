/**
 * Coverage for the §3/§O RBAC expansion: authorizeOrPermission() wired onto
 * pricing-rule create/version routes, and PATCH /staff/:id's new
 * permissionOverrides field that actually lets an Org Admin grant a named
 * exception — closing the gap pricingRule.routes.js had flagged since
 * Phase 4 (hasPermission() existed and was tested in isolation, but no
 * route ever called it, and no API ever let an admin set the override).
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

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner18@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner18@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

describe('authorizeOrPermission on pricing-rule routes', () => {
  test('a Manager without pricing.edit is blocked; granting it via PATCH /staff/:id then allows pricing rule creation; DENY still wins if later added', async () => {
    const code = 'rbac-pricing'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9800000001' })
    const { token: adminToken } = await staffLogin(app, code, '9800000001', 'Admin@123')
    const deviceUuid = 'device-rbac-pricing'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const locRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: 'RBAC Lot', geo: { lat: 12.9716, lng: 77.5946 }, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
    })
    const locationId = locRes.body.data.location._id
    const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
    const vehicleTypeId = vtRes.body.data.vehicleType._id

    const managerRes = await signedReq(app, 'post', '/staff', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { name: 'Manager Mo', phone: '9800000009', password: 'Manager@123', role: 'MANAGER' },
    })
    expect(managerRes.status).toBe(201)
    const managerId = managerRes.body.data.staff.id
    const { token: managerToken } = await staffLogin(app, code, '9800000009', 'Manager@123')

    const pricingBody = { locationId, vehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Flat', config: { flatAmountMinor: 1000 } }

    const blockedRes = await signedReq(app, 'post', '/pricing-rules', { token: managerToken, deviceUuid, deviceSecret, body: pricingBody })
    expect(blockedRes.status).toBe(403)
    expect(blockedRes.body.code).toBe('FORBIDDEN_ROLE')

    const grantRes = await signedReq(app, 'patch', `/staff/${managerId}`, {
      token: adminToken, deviceUuid, deviceSecret,
      body: { permissionOverrides: [{ code: 'pricing.edit', effect: 'GRANT' }] },
    })
    expect(grantRes.status).toBe(200)

    const allowedRes = await signedReq(app, 'post', '/pricing-rules', { token: managerToken, deviceUuid, deviceSecret, body: pricingBody })
    expect(allowedRes.status).toBe(201)

    // GET /staff/me must reflect the Manager's OWN grant — otherwise the app
    // has no way to show the "New Pricing Rule" button before the API 403s it.
    const meRes = await signedReq(app, 'get', '/staff/me', { token: managerToken, deviceUuid, deviceSecret })
    expect(meRes.status).toBe(200)
    expect(meRes.body.data.staff.permissionOverrides).toEqual([expect.objectContaining({ code: 'pricing.edit', effect: 'GRANT' })])

    const revokeRes = await signedReq(app, 'patch', `/staff/${managerId}`, {
      token: adminToken, deviceUuid, deviceSecret,
      body: { permissionOverrides: [{ code: 'pricing.edit', effect: 'GRANT' }, { code: 'pricing.edit', effect: 'DENY' }] },
    })
    expect(revokeRes.status).toBe(200)

    const deniedAgainRes = await signedReq(app, 'post', '/pricing-rules', {
      token: managerToken, deviceUuid, deviceSecret, body: { ...pricingBody, name: 'Flat 2' },
    })
    expect(deniedAgainRes.status).toBe(403)
  })

  test('ORG_ADMIN can always create pricing rules regardless of permissionOverrides', async () => {
    const code = 'rbac-admin'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9800000011' })
    const { token: adminToken } = await staffLogin(app, code, '9800000011', 'Admin@123')
    const deviceUuid = 'device-rbac-admin'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)
    const locRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: 'Admin Lot', geo: { lat: 12.9716, lng: 77.5946 }, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
    })
    const locationId = locRes.body.data.location._id
    const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
    const vehicleTypeId = vtRes.body.data.vehicleType._id

    const res = await signedReq(app, 'post', '/pricing-rules', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { locationId, vehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Flat', config: { flatAmountMinor: 500 } },
    })
    expect(res.status).toBe(201)
  })
})
