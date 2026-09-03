/**
 * Coverage for §20 Notifications: the notify()/notifyRoles() funnel (in-app
 * channel), GET/PATCH /notifications (a staff member's own inbox only), and
 * the real trigger wired into shift.service.js's closeShift — a cash
 * mismatch requiring approval notifies every Manager/Org Admin in the org.
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
  await PlatformAdmin.create({ name: 'Owner', email: 'owner19@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner19@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

describe('notification.service — funnel behavior', () => {
  test('notify() writes an in-app Notification row; notifyRoles() fans out to every matching-role staff member', async () => {
    const code = 'notif-service'
    const org = await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9900000001' })
    const { token: adminToken } = await staffLogin(app, code, '9900000001', 'Admin@123')
    const deviceUuid = 'device-notif-service'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const mgrRes = await signedReq(app, 'post', '/staff', {
      token: adminToken, deviceUuid, deviceSecret, body: { name: 'Mgr One', phone: '9900000011', password: 'Manager@123', role: 'MANAGER' },
    })
    expect(mgrRes.status).toBe(201)

    const notificationService = require('../services/notification.service')
    await notificationService.notifyRoles({
      organizationId: org.organization._id, roles: ['MANAGER', 'ORG_ADMIN'], type: 'TEST', severity: 'INFO',
      title: 'Test alert', body: 'body text',
    })

    const Notification = require('../models/Notification')
    const rows = await Notification.find({ organizationId: org.organization._id, type: 'TEST' })
    // one for the ORG_ADMIN, one for the MANAGER — both match ['MANAGER','ORG_ADMIN']
    expect(rows.length).toBe(2)
  })
})

describe('GET/PATCH /notifications — own inbox only', () => {
  test('a shift closing with a mismatch needing approval notifies Managers/Org Admins, who can read and mark it read', async () => {
    const code = 'notif-shift'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9900000021' })
    const { token: adminToken } = await staffLogin(app, code, '9900000021', 'Admin@123')
    const deviceUuid = 'device-notif-shift'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const locRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: 'Notif Lot', geo: { lat: 12.9716, lng: 77.5946 }, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
    })
    const locationId = locRes.body.data.location._id

    const staffRes = await signedReq(app, 'post', '/staff', {
      token: adminToken, deviceUuid, deviceSecret, body: { name: 'Staff Sam', phone: '9900000029', password: 'Staff@123', role: 'STAFF' },
    })
    expect(staffRes.status).toBe(201)
    const { token: staffToken } = await staffLogin(app, code, '9900000029', 'Staff@123')

    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: staffToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
    const shiftInstanceId = shiftRes.body.data.shiftInstance._id

    // Above the ₹100 mismatch-approval threshold (MISMATCH_APPROVAL_THRESHOLD_MINOR = 10000).
    const closeRes = await signedReq(app, 'post', `/shifts/${shiftInstanceId}/close`, {
      token: staffToken, deviceUuid, deviceSecret, body: { actualCashMinor: 50000, notes: 'unexplained surplus' },
    })
    expect(closeRes.status).toBe(200)
    expect(closeRes.body.data.requiresApproval).toBe(true)

    const inboxRes = await signedReq(app, 'get', '/notifications', { token: adminToken, deviceUuid, deviceSecret })
    expect(inboxRes.status).toBe(200)
    const mismatchNotif = inboxRes.body.data.notifications.find((n) => n.type === 'SHIFT_TALLY_MISMATCH')
    expect(mismatchNotif).toBeDefined()
    expect(mismatchNotif.readAt).toBeFalsy()
    expect(inboxRes.body.data.unreadCount).toBeGreaterThanOrEqual(1)

    const readRes = await signedReq(app, 'patch', `/notifications/${mismatchNotif._id}/read`, { token: adminToken, deviceUuid, deviceSecret, body: {} })
    expect(readRes.status).toBe(200)
    expect(readRes.body.data.notification.readAt).not.toBeNull()

    // A different staff member never sees someone else's notification.
    const otherInboxRes = await signedReq(app, 'get', '/notifications', { token: staffToken, deviceUuid, deviceSecret })
    expect(otherInboxRes.body.data.notifications.find((n) => n.type === 'SHIFT_TALLY_MISMATCH')).toBeUndefined()
  })
})
