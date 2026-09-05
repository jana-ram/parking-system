/**
 * Coverage for the Phase 17 reconciliation/reporting upgrade (§22/§23/§34):
 * revenue-by-method now actually respects a locationId filter (closing the
 * documented gap in report.controller.js), the shift transaction drill-down,
 * the Correction/audit report, and the staff-collection CSV export.
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

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = replSet.getUri()
  await mongoose.connect(process.env.MONGO_URI)
  ;({ app } = require('../server'))
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))

  const PlatformAdmin = require('../models/PlatformAdmin')
  const Country = require('../models/Country')
  await PlatformAdmin.create({ name: 'Owner', email: 'owner17@test.com', password: 'Owner@123' })
  const country = await Country.create({ isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' })
  countryId = country._id.toString()
  platformToken = await platformLogin(app, 'owner17@test.com', 'Owner@123')
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

describe('C0: revenue-by-method now respects the locationId filter', () => {
  test('a locationId filter excludes payments from other locations', async () => {
    const code = 'recon-loc'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9700000001' })
    const { token: adminToken } = await staffLogin(app, code, '9700000001', 'Admin@123')
    const deviceUuid = 'device-recon-loc'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
    const vehicleTypeId = vtRes.body.data.vehicleType._id

    const locations = []
    for (const name of ['Lot A', 'Lot B']) {
      const locRes = await signedReq(app, 'post', '/locations', {
        token: adminToken, deviceUuid, deviceSecret,
        body: { countryId, name, geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
      })
      locations.push(locRes.body.data.location._id)
      await signedReq(app, 'post', '/pricing-rules', {
        token: adminToken, deviceUuid, deviceSecret,
        body: { locationId: locRes.body.data.location._id, vehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Flat', config: { flatAmountMinor: 1000 } },
      })
    }
    const [locationA, locationB] = locations

    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId: locationA, openingCashMinor: 0 } })
    expect(shiftRes.status).toBe(201)

    // One open shift processes entries at both locations — shiftCheck only
    // requires an OPEN shift for this (staff, device), not a location match;
    // both locations share the same GOOD_GEO so the mocked GPS check passes
    // for either.
    for (const [locationId, plate] of [[locationA, 'KA01A0001'], [locationB, 'KA01B0002']]) {
      const tokenRes = await signedReq(app, 'post', '/tokens/batches', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, batchSize: 1 } })
      const tokenCode = tokenRes.body.data.tokens[0].tokenCode
      const entryRes = await signedReq(app, 'post', '/sessions/entry', {
        token: adminToken, deviceUuid, deviceSecret,
        body: { clientTransactionId: `ctx-recon-${plate}`, locationId, vehicleNumber: plate, vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
      })
      expect(entryRes.status).toBe(201)
      await signedReq(app, 'post', `/sessions/${entryRes.body.data.sessionId}/payment`, {
        token: adminToken, deviceUuid, deviceSecret, body: { clientTransactionId: `ctx-recon-pay-${plate}`, method: 'CASH', amountMinor: 1000 },
      })
    }

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    const allRes = await signedReq(app, 'get', '/reports/summary', { token: adminToken, deviceUuid, deviceSecret, query: { from, to } })
    expect(allRes.body.data.totalRevenueMinor).toBe(2000)

    const filteredRes = await signedReq(app, 'get', '/reports/summary', { token: adminToken, deviceUuid, deviceSecret, query: { from, to, locationId: locationA } })
    expect(filteredRes.body.data.totalRevenueMinor).toBe(1000)

    // §22/§36 — the combined total is broken down per module, not just Parking.
    expect(allRes.body.data.byModule.parking.revenueMinor).toBe(2000)
    expect(allRes.body.data.byModule.luggage.revenueMinor).toBe(0)
    expect(allRes.body.data.byModule.parcel.revenueMinor).toBe(0)
  })
})

describe('C0b: summary CSV export', () => {
  test('GET /reports/summary/export returns a CSV with a row per module plus a total', async () => {
    const code = 'recon-export'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9700000041' })
    const { token: adminToken } = await staffLogin(app, code, '9700000041', 'Admin@123')
    const deviceUuid = 'device-recon-export'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const res = await signedReq(app, 'get', '/reports/summary/export', { token: adminToken, deviceUuid, deviceSecret, query: { from, to } })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.text).toContain('Module')
    expect(res.text).toContain('Parking')
    expect(res.text).toContain('Luggage')
    expect(res.text).toContain('Parcel')
    expect(res.text).toContain('TOTAL')
  })
})

describe('C0c: summary XLSX export (format=xlsx)', () => {
  test('GET /reports/summary/export?format=xlsx returns a real, readable .xlsx workbook', async () => {
    const code = 'recon-export-xlsx'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9700000042' })
    const { token: adminToken } = await staffLogin(app, code, '9700000042', 'Admin@123')
    const deviceUuid = 'device-recon-export-xlsx'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const res = await signedReq(app, 'get', '/reports/summary/export', { token: adminToken, deviceUuid, deviceSecret, query: { from, to, format: 'xlsx' } }).buffer(true).parse((response, callback) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => callback(null, Buffer.concat(chunks)))
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/spreadsheetml/)
    expect(res.headers['content-disposition']).toContain('.xlsx')

    // Prove the bytes are a real, parseable workbook, not just a mislabeled
    // CSV — round-trip it through exceljs itself.
    const ExcelJS = require('exceljs')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(res.body)
    const sheet = workbook.getWorksheet('Summary')
    expect(sheet).toBeDefined()
    const headerRow = sheet.getRow(1).values.filter(Boolean)
    expect(headerRow).toContain('Module')
    const moduleColumn = sheet.getColumn(1).values.filter(Boolean)
    expect(moduleColumn).toContain('Parking')
    expect(moduleColumn).toContain('TOTAL')
  })
})

describe('C1: shift transaction drill-down', () => {
  test('GET /reports/shifts/:id/transactions lists the sessions + payments under that shift', async () => {
    const code = 'recon-drilldown'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9700000011' })
    const { token: adminToken } = await staffLogin(app, code, '9700000011', 'Admin@123')
    const deviceUuid = 'device-recon-drilldown'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const locRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: 'Drill Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
    })
    const locationId = locRes.body.data.location._id
    const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
    const vehicleTypeId = vtRes.body.data.vehicleType._id
    await signedReq(app, 'post', '/pricing-rules', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { locationId, vehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Flat', config: { flatAmountMinor: 4000 } },
    })
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
    const shiftInstanceId = shiftRes.body.data.shiftInstance._id

    const tokenRes = await signedReq(app, 'post', '/tokens/batches', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, batchSize: 1 } })
    const tokenCode = tokenRes.body.data.tokens[0].tokenCode
    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-drill-1', locationId, vehicleNumber: 'KA02DR1234', vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    const sessionId = entryRes.body.data.sessionId
    await signedReq(app, 'post', `/sessions/${sessionId}/payment`, {
      token: adminToken, deviceUuid, deviceSecret, body: { clientTransactionId: 'ctx-drill-pay-1', method: 'CASH', amountMinor: 4000 },
    })

    const res = await signedReq(app, 'get', `/reports/shifts/${shiftInstanceId}/transactions`, { token: adminToken, deviceUuid, deviceSecret })
    expect(res.status).toBe(200)
    expect(res.body.data.count).toBe(1)
    const txn = res.body.data.transactions[0]
    expect(txn.sessionId).toBe(sessionId)
    expect(txn.vehicleNumber).toBe('KA02DR1234')
    expect(txn.payments.length).toBe(1)
    expect(txn.payments[0].amountMinor).toBe(4000)
  })
})

describe('C2: corrections report', () => {
  test('GET /reports/corrections surfaces a manual amount override made elsewhere in the system', async () => {
    const code = 'recon-corr'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9700000021' })
    const { token: adminToken } = await staffLogin(app, code, '9700000021', 'Admin@123')
    const deviceUuid = 'device-recon-corr'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const locRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: 'Corr Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
    })
    const locationId = locRes.body.data.location._id
    const vtRes = await signedReq(app, 'post', '/vehicle-types', { token: adminToken, deviceUuid, deviceSecret, body: { code: 'CAR', name: 'Car' } })
    const vehicleTypeId = vtRes.body.data.vehicleType._id
    await signedReq(app, 'post', '/pricing-rules', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { locationId, vehicleTypeId, mode: 'PAY_ON_ENTRY', name: 'Flat', config: { flatAmountMinor: 1500 } },
    })
    await signedReq(app, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
    const tokenRes = await signedReq(app, 'post', '/tokens/batches', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, batchSize: 1 } })
    const tokenCode = tokenRes.body.data.tokens[0].tokenCode
    const entryRes = await signedReq(app, 'post', '/sessions/entry', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { clientTransactionId: 'ctx-corrrep-1', locationId, vehicleNumber: 'KA03CR1234', vehicleTypeId, tokenCode, locationCheck: goodLocationCheck() },
    })
    const sessionId = entryRes.body.data.sessionId

    await signedReq(app, 'post', `/sessions/${sessionId}/override-amount`, {
      token: adminToken, deviceUuid, deviceSecret, body: { manualAmountMinor: 1000, reason: 'reporting test' },
    })

    const res = await signedReq(app, 'get', '/reports/corrections', { token: adminToken, deviceUuid, deviceSecret, query: { entityType: 'ParkingSession' } })
    expect(res.status).toBe(200)
    const row = res.body.data.corrections.find((c) => c.entityId === sessionId)
    expect(row).toBeDefined()
    expect(row.oldValue).toBe(1500)
    expect(row.newValue).toBe(1000)
    expect(row.reason).toBe('reporting test')
  })
})

describe('C3: staff-collection CSV export', () => {
  test('returns text/csv with the shift row', async () => {
    const code = 'recon-csv'
    await onboardOrg(app, { platformToken, code, countryId, adminPhone: '9700000031' })
    const { token: adminToken } = await staffLogin(app, code, '9700000031', 'Admin@123')
    const deviceUuid = 'device-recon-csv'
    const deviceSecret = await registerDevice(app, adminToken, deviceUuid)

    const locRes = await signedReq(app, 'post', '/locations', {
      token: adminToken, deviceUuid, deviceSecret,
      body: { countryId, name: 'CSV Lot', geo: GOOD_GEO, timezone: 'Asia/Kolkata', currency: 'INR', geofenceRadiusM: 150 },
    })
    const locationId = locRes.body.data.location._id
    const shiftRes = await signedReq(app, 'post', '/shifts/start', { token: adminToken, deviceUuid, deviceSecret, body: { locationId, openingCashMinor: 0 } })
    const closeRes = await signedReq(app, 'post', `/shifts/${shiftRes.body.data.shiftInstance._id}/close`, { token: adminToken, deviceUuid, deviceSecret, body: { actualCashMinor: 0 } })
    expect(closeRes.status).toBe(200)

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const res = await signedReq(app, 'get', '/reports/staff-collection/export', { token: adminToken, deviceUuid, deviceSecret, query: { from, to } })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.text).toContain('Shift ID')
    expect(res.text).toContain(String(shiftRes.body.data.shiftInstance._id))
  })
})
