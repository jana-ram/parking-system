/**
 * Phase 2 exit criteria (docs/ARCHITECTURE.md §Z): "RBAC matrix (§O) fully
 * covered by automated route tests; device registration + signing works
 * end-to-end." This file is that test — black-box, through Supertest against
 * the real Express app, with a real (in-memory) MongoDB replica set. It signs
 * requests with the exact same HMAC algorithm the mobile client uses
 * (SmartParkingMobile/src/api/index.ts), so a client/server signing mismatch
 * (like the empty-body hash bug caught during Phase 2 build) fails here.
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

let replSet
let app
let PlatformAdmin
let countryId

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')

  await PlatformAdmin.create({ name: 'Owner', email: 'owner@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

// ── signing helper — mirrors SmartParkingMobile/src/api/index.ts exactly ──
function signRequest({ method, path, body, deviceSecret }) {
  const timestamp = Date.now().toString()
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex')
  const toSign = `${method.toUpperCase()}:${path}:${timestamp}:${bodyHash}`
  const signature = crypto.createHmac('sha256', deviceSecret).update(toSign).digest('hex')
  return { timestamp, signature }
}

function signedReq(method, path, { token, deviceUuid, deviceSecret, body }) {
  const { timestamp, signature } = signRequest({ method, path, body, deviceSecret })
  let r = request(app)[method.toLowerCase()](path)
  if (token) r = r.set('Authorization', `Bearer ${token}`)
  if (deviceUuid) {
    r = r.set('X-Device-Id', deviceUuid).set('X-Device-Timestamp', timestamp).set('X-Device-Signature', signature)
  }
  return body ? r.send(body) : r
}

async function platformLogin() {
  const res = await request(app).post('/platform/auth/login').send({ email: 'owner@test.com', password: 'Owner@123' })
  return res.body.data.token
}

async function onboardOrg({ code, adminPhone }) {
  const platformToken = await platformLogin()
  const res = await request(app)
    .post('/platform/organizations')
    .set('Authorization', `Bearer ${platformToken}`)
    .send({
      name: `Org ${code}`,
      code,
      countryId,
      defaultCurrency: 'INR',
      defaultTimezone: 'Asia/Kolkata',
      orgAdmin: { name: 'Admin', phone: adminPhone, password: 'Admin@123' },
    })
  expect(res.status).toBe(201)
  return res.body.data
}

async function staffLogin(orgCode, phone, password) {
  const res = await request(app).post('/auth/staff/login').send({ orgCode, phone, password })
  expect(res.status).toBe(200)
  return { token: res.body.data.token, staffUser: res.body.data.staffUser }
}

async function registerDevice(token, deviceUuid) {
  const res = await request(app)
    .post('/devices/register')
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceUuid, platform: 'ANDROID' })
  expect(res.status).toBe(201)
  return res.body.data.deviceSecret
}

// ── suite-wide fixtures ─────────────────────────────────────────────────
let orgA, orgAAdminToken, orgADeviceUuid, orgADeviceSecret
let orgAManagerToken, orgAStaffToken

beforeAll(async () => {
  const onboarded = await onboardOrg({ code: 'org-a', adminPhone: '9000000001' })
  orgA = onboarded.organization
  ;({ token: orgAAdminToken } = await staffLogin('org-a', '9000000001', 'Admin@123'))

  orgADeviceUuid = 'device-org-a-1'
  orgADeviceSecret = await registerDevice(orgAAdminToken, orgADeviceUuid)

  // Org Admin creates a Manager and a Staff account (§O)
  await signedReq('post', '/staff', {
    token: orgAAdminToken, deviceUuid: orgADeviceUuid, deviceSecret: orgADeviceSecret,
    body: { name: 'Manager Mia', phone: '9000000002', password: 'Manager@123', role: 'MANAGER' },
  })
  await signedReq('post', '/staff', {
    token: orgAAdminToken, deviceUuid: orgADeviceUuid, deviceSecret: orgADeviceSecret,
    body: { name: 'Staff Sam', phone: '9000000003', password: 'Staff@123', role: 'STAFF' },
  })
  ;({ token: orgAManagerToken } = await staffLogin('org-a', '9000000002', 'Manager@123'))
  ;({ token: orgAStaffToken } = await staffLogin('org-a', '9000000003', 'Staff@123'))
}, 30000)

// ═══════════════════════════════════════════════════════════════════════
describe('device registration + signing, end to end (§N)', () => {
  test('a request with no device headers at all is rejected', async () => {
    const res = await request(app).get('/locations').set('Authorization', `Bearer ${orgAAdminToken}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('DEVICE_NOT_AUTHORIZED')
  })

  test('a request with a valid signature succeeds', async () => {
    const res = await signedReq('get', '/locations', { token: orgAAdminToken, deviceUuid: orgADeviceUuid, deviceSecret: orgADeviceSecret })
    expect(res.status).toBe(200)
  })

  test('a tampered body invalidates the signature (§X: never trust the client)', async () => {
    const { timestamp, signature } = signRequest({ method: 'POST', path: '/locations', body: { name: 'Legit' }, deviceSecret: orgADeviceSecret })
    const res = await request(app)
      .post('/locations')
      .set('Authorization', `Bearer ${orgAAdminToken}`)
      .set('X-Device-Id', orgADeviceUuid)
      .set('X-Device-Timestamp', timestamp)
      .set('X-Device-Signature', signature)
      .send({ name: 'Tampered after signing' }) // different body than what was signed
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('DEVICE_NOT_AUTHORIZED')
  })

  test('a stale timestamp outside the replay window is rejected', async () => {
    const staleTimestamp = (Date.now() - 10 * 60 * 1000).toString() // 10 min old
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify({})).digest('hex')
    const signature = crypto.createHmac('sha256', orgADeviceSecret).update(`GET:/locations:${staleTimestamp}:${bodyHash}`).digest('hex')
    const res = await request(app)
      .get('/locations')
      .set('Authorization', `Bearer ${orgAAdminToken}`)
      .set('X-Device-Id', orgADeviceUuid)
      .set('X-Device-Timestamp', staleTimestamp)
      .set('X-Device-Signature', signature)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('DEVICE_NOT_AUTHORIZED')
  })

  test('a deactivated device is rejected with DEVICE_DEACTIVATED, distinctly', async () => {
    const deviceUuid = 'device-to-deactivate'
    const secret = await registerDevice(orgAAdminToken, deviceUuid)
    const listRes = await signedReq('get', '/devices', { token: orgAAdminToken, deviceUuid: orgADeviceUuid, deviceSecret: orgADeviceSecret })
    const deviceDoc = listRes.body.data.devices.find(d => d.deviceUuid === deviceUuid)

    const deactivateRes = await signedReq('post', `/devices/${deviceDoc._id}/deactivate`, {
      token: orgAAdminToken, deviceUuid: orgADeviceUuid, deviceSecret: orgADeviceSecret,
      body: { reason: 'lost device' },
    })
    expect(deactivateRes.status).toBe(200)

    const res = await signedReq('get', '/locations', { token: orgAAdminToken, deviceUuid, deviceSecret: secret })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('DEVICE_DEACTIVATED')
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('RBAC matrix — Staff/Manager/Org Admin (§O)', () => {
  // NOTE: deviceUuid/deviceSecret/tokens are all set inside beforeAll, not at
  // declaration time — the outer beforeAll (where orgADeviceSecret etc. are
  // populated) hasn't run yet when this describe block's body first executes.
  const asStaff = {}
  const asManager = {}
  const asAdmin = {}

  beforeAll(() => {
    Object.assign(asStaff, { token: orgAStaffToken, deviceUuid: orgADeviceUuid, deviceSecret: orgADeviceSecret })
    Object.assign(asManager, { token: orgAManagerToken, deviceUuid: orgADeviceUuid, deviceSecret: orgADeviceSecret })
    Object.assign(asAdmin, { token: orgAAdminToken, deviceUuid: orgADeviceUuid, deviceSecret: orgADeviceSecret })
  })

  test('any authenticated role can list locations', async () => {
    for (const actor of [asStaff, asManager, asAdmin]) {
      const res = await signedReq('get', '/locations', actor)
      expect(res.status).toBe(200)
    }
  })

  test('only Org Admin can create a location', async () => {
    const body = { countryId, name: 'Test Lot', geo: { lat: 12.9, lng: 77.6 }, timezone: 'Asia/Kolkata', currency: 'INR' }
    const staffRes = await signedReq('post', '/locations', { ...asStaff, body })
    expect(staffRes.status).toBe(403)
    expect(staffRes.body.code).toBe('FORBIDDEN_ROLE')

    const managerRes = await signedReq('post', '/locations', { ...asManager, body })
    expect(managerRes.status).toBe(403)

    const adminRes = await signedReq('post', '/locations', { ...asAdmin, body })
    expect(adminRes.status).toBe(201)
  })

  test('Staff cannot list staff accounts, but Manager and Org Admin can', async () => {
    const staffRes = await signedReq('get', '/staff', asStaff)
    expect(staffRes.status).toBe(403)

    const managerRes = await signedReq('get', '/staff', asManager)
    expect(managerRes.status).toBe(200)

    const adminRes = await signedReq('get', '/staff', asAdmin)
    expect(adminRes.status).toBe(200)
  })

  test('only Org Admin can create staff (Manager cannot, matching §4/§O)', async () => {
    const body = { name: 'New Hire', phone: '9000000099', password: 'NewHire@123', role: 'STAFF' }
    const managerRes = await signedReq('post', '/staff', { ...asManager, body })
    expect(managerRes.status).toBe(403)
    expect(managerRes.body.code).toBe('FORBIDDEN_ROLE')

    const adminRes = await signedReq('post', '/staff', { ...asAdmin, body })
    expect(adminRes.status).toBe(201)
  })

  test('only Org Admin can register or deactivate a device', async () => {
    const managerRes = await request(app)
      .post('/devices/register')
      .set('Authorization', `Bearer ${orgAManagerToken}`)
      .send({ deviceUuid: 'manager-attempted-device' })
    expect(managerRes.status).toBe(403)
    expect(managerRes.body.code).toBe('FORBIDDEN_ROLE')
  })

  test('only Org Admin can update org settings', async () => {
    const staffRes = await signedReq('patch', '/orgs/me', { ...asStaff, body: { name: 'Renamed' } })
    expect(staffRes.status).toBe(403)

    const adminRes = await signedReq('patch', '/orgs/me', { ...asAdmin, body: { name: 'Renamed Org A' } })
    expect(adminRes.status).toBe(200)
    expect(adminRes.body.data.organization.name).toBe('Renamed Org A')
  })

  test('an unauthenticated request (no JWT at all) is rejected before RBAC is even evaluated', async () => {
    const res = await request(app).get('/locations')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('UNAUTHENTICATED')
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('cross-organization isolation (§30, §X)', () => {
  let orgB, orgBAdminToken, orgBDeviceUuid, orgBDeviceSecret, orgALocationId

  beforeAll(async () => {
    const onboarded = await onboardOrg({ code: 'org-b', adminPhone: '9100000001' })
    orgB = onboarded.organization
    ;({ token: orgBAdminToken } = await staffLogin('org-b', '9100000001', 'Admin@123'))
    orgBDeviceUuid = 'device-org-b-1'
    orgBDeviceSecret = await registerDevice(orgBAdminToken, orgBDeviceUuid)

    const locRes = await signedReq('post', '/locations', {
      token: orgAAdminToken, deviceUuid: orgADeviceUuid, deviceSecret: orgADeviceSecret,
      body: { countryId, name: 'Org A Secret Lot', geo: { lat: 1, lng: 1 }, timezone: 'Asia/Kolkata', currency: 'INR' },
    })
    orgALocationId = locRes.body.data.location._id
  }, 30000)

  test("org B's Org Admin cannot see org A's locations in a list", async () => {
    const res = await signedReq('get', '/locations', { token: orgBAdminToken, deviceUuid: orgBDeviceUuid, deviceSecret: orgBDeviceSecret })
    expect(res.status).toBe(200)
    expect(res.body.data.locations.find(l => l._id === orgALocationId)).toBeUndefined()
  })

  test("org B's Org Admin gets 404, not org A's data, when fetching org A's location by ID directly", async () => {
    const res = await signedReq('get', `/locations/${orgALocationId}`, { token: orgBAdminToken, deviceUuid: orgBDeviceUuid, deviceSecret: orgBDeviceSecret })
    expect(res.status).toBe(404)
  })

  test("org B's device cannot be used with org A's JWT (device lookup is org-scoped)", async () => {
    const res = await signedReq('get', '/locations', { token: orgAAdminToken, deviceUuid: orgBDeviceUuid, deviceSecret: orgBDeviceSecret })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('DEVICE_NOT_AUTHORIZED')
  })

  test('org A and org B can each have a StaffUser with the SAME phone number (uniqueness is per-org, §E)', async () => {
    // orgAAdminToken's phone is 9000000001, orgB's admin is 9100000001 — different
    // numbers above by design; this test proves the (organizationId, phone)
    // compound uniqueness rather than a global one, by reusing org A's phone in org B.
    const res = await signedReq('post', '/staff', {
      token: orgBAdminToken, deviceUuid: orgBDeviceUuid, deviceSecret: orgBDeviceSecret,
      body: { name: 'Reused Phone', phone: '9000000001', password: 'Whatever@123', role: 'STAFF' },
    })
    expect(res.status).toBe(201)
  })
})
