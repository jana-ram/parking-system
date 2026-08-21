/**
 * Shared black-box test helpers — Supertest against the real Express app,
 * signing requests with the EXACT same HMAC algorithm the mobile client uses
 * (SmartParkingMobile/src/api/index.ts). Used by every phaseN integration
 * test so a client/server protocol mismatch is caught here, once, rather
 * than re-implemented (and potentially re-drifted) per test file.
 */
const crypto = require('crypto')
const request = require('supertest')

function signRequest({ method, path, body, deviceSecret }) {
  const timestamp = Date.now().toString()
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex')
  const toSign = `${method.toUpperCase()}:${path}:${timestamp}:${bodyHash}`
  const signature = crypto.createHmac('sha256', deviceSecret).update(toSign).digest('hex')
  return { timestamp, signature }
}

function signedReq(app, method, path, { token, deviceUuid, deviceSecret, body, query }) {
  const { timestamp, signature } = signRequest({ method, path, body, deviceSecret })
  let r = request(app)[method.toLowerCase()](path)
  if (query) r = r.query(query)
  if (token) r = r.set('Authorization', `Bearer ${token}`)
  if (deviceUuid) {
    r = r.set('X-Device-Id', deviceUuid).set('X-Device-Timestamp', timestamp).set('X-Device-Signature', signature)
  }
  return body ? r.send(body) : r
}

async function platformLogin(app, email, password) {
  const res = await request(app).post('/platform/auth/login').send({ email, password })
  return res.body.data.token
}

async function onboardOrg(app, { platformToken, code, countryId, adminPhone }) {
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
  if (res.status !== 201) throw new Error(`onboardOrg failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data
}

async function staffLogin(app, orgCode, phone, password) {
  const res = await request(app).post('/auth/staff/login').send({ orgCode, phone, password })
  if (res.status !== 200) throw new Error(`staffLogin failed: ${res.status} ${JSON.stringify(res.body)}`)
  return { token: res.body.data.token, staffUser: res.body.data.staffUser }
}

async function registerDevice(app, token, deviceUuid) {
  const res = await request(app).post('/devices/register').set('Authorization', `Bearer ${token}`).send({ deviceUuid, platform: 'ANDROID' })
  if (res.status !== 201) throw new Error(`registerDevice failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data.deviceSecret
}

module.exports = { signRequest, signedReq, platformLogin, onboardOrg, staffLogin, registerDevice }
