const crypto = require('crypto')
const Device = require('../models/Device')
const { decryptDeviceSecret } = require('../utils/deviceSecret')
const { createError } = require('../utils/helpers')

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000 // replay-window, §N/§X

/**
 * deviceCheck — verifies X-Device-Id / X-Device-Timestamp / X-Device-Signature
 * (§N). Must run AFTER protect() (needs req.staffUser.organizationId) and
 * BEFORE any handler that performs a sensitive write — a deactivated device
 * is rejected here, before it can reach business logic at all (§28).
 *
 * Deliberately returns the SAME generic "device not authorized" message for
 * every failure mode (missing headers, unknown device, bad signature, clock
 * skew, deactivated) — never revealing which check failed, so a would-be
 * spoofer can't use the error to narrow down what to fix next (§M).
 */
const DEVICE_ERROR = () => createError(403, 'This device is not authorized', null, 'DEVICE_NOT_AUTHORIZED')

const deviceCheck = async (req, res, next) => {
  try {
    const deviceId = req.headers['x-device-id']
    const timestamp = req.headers['x-device-timestamp']
    const signature = req.headers['x-device-signature']
    if (!deviceId || !timestamp || !signature) return next(DEVICE_ERROR())

    const skew = Math.abs(Date.now() - Number(timestamp))
    if (!Number.isFinite(skew) || skew > MAX_CLOCK_SKEW_MS) return next(DEVICE_ERROR())

    const device = await Device.findOne({
      deviceUuid: deviceId,
      organizationId: req.staffUser.organizationId,
    }).select('+deviceSecretEnc')

    if (!device) return next(DEVICE_ERROR())
    if (device.status !== 'ACTIVE') {
      return next(createError(403, 'This device has been deactivated', null, 'DEVICE_DEACTIVATED'))
    }

    const secret = decryptDeviceSecret(device.deviceSecretEnc)
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex')
    // Path WITHOUT the query string. The mobile client signs `config.url`
    // (SmartParkingMobile/src/api/index.ts) at axios-interceptor time, which
    // for a GET with `{params}` is still just the bare path — axios only
    // serializes params onto the URL AFTER interceptors run, so the client
    // has no query string available to include in its signature even if it
    // wanted to. req.originalUrl DOES include the query string, so signing
    // against it would make every query-parameterized GET request fail
    // verification unconditionally. Deliberately excluding query params from
    // the signed material is a reasonable simplification, not an oversight —
    // for this API, query strings are read-only filters, not something that
    // needs the same tamper-protection as a mutating body.
    const pathForSigning = req.originalUrl.split('?')[0]
    const toSign = `${req.method}:${pathForSigning}:${timestamp}:${bodyHash}`
    const expected = crypto.createHmac('sha256', secret).update(toSign).digest('hex')

    const sigBuf = Buffer.from(String(signature), 'hex')
    const expBuf = Buffer.from(expected, 'hex')
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return next(DEVICE_ERROR())
    }

    device.lastActiveAt = new Date()
    await device.save()

    req.device = device
    next()
  } catch (err) {
    next(err)
  }
}

module.exports = deviceCheck
