const Device = require('../models/Device')
const auditLog = require('../services/auditLog.service')
const { generateDeviceSecret, encryptDeviceSecret } = require('../utils/deviceSecret')
const { createError } = require('../utils/helpers')

const listDevices = async (req, res, next) => {
  try {
    const devices = await Device.find({ organizationId: req.staffUser.organizationId }).sort({ createdAt: -1 })
    res.json({ success: true, message: 'ok', data: { devices } })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /devices/register — deliberately NOT behind deviceCheck (§N): a device
 * has no secret to sign with until this call returns one. Bootstrapped by
 * protect() + authorize('ORG_ADMIN') alone. The plaintext secret is returned
 * exactly once, here, and never again — the server only ever stores the
 * encrypted-at-rest copy after this point.
 */
const registerDevice = async (req, res, next) => {
  try {
    const { deviceUuid, locationId, platform, appVersion, osVersion } = req.body

    // deviceUuid is globally unique (schema-level, §E) — this check is
    // legitimately cross-tenant, so it's the one sanctioned skipOrgScope use
    // here, not a bug requireOrgScope should catch (it did catch this,
    // correctly, before this fix — see the deliberate opt-out below).
    const existing = await Device.findOne({ deviceUuid }).setOptions({ skipOrgScope: true })
    if (existing) return next(createError(409, 'This device is already registered', null, 'VALIDATION_ERROR'))

    const plaintextSecret = generateDeviceSecret()
    const device = await Device.create({
      organizationId: req.staffUser.organizationId,
      locationId: locationId || null,
      deviceUuid,
      deviceSecretEnc: encryptDeviceSecret(plaintextSecret),
      registeredBy: req.staffUser._id,
      platform,
      appVersion,
      osVersion,
    })

    await auditLog.record(req, {
      action: 'DEVICE_REGISTERED',
      entityType: 'Device',
      entityId: device._id,
      newValue: { deviceUuid, locationId },
      locationId: locationId || undefined,
    })

    res.status(201).json({
      success: true,
      message: 'Device registered',
      data: {
        device: { id: device._id, deviceUuid: device.deviceUuid, status: device.status },
        deviceSecret: plaintextSecret, // returned once — client must persist this immediately
      },
    })
  } catch (err) {
    next(err)
  }
}

const deactivateDevice = async (req, res, next) => {
  try {
    const { reason } = req.body
    const device = await Device.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!device) return next(createError(404, 'Device not found', null, 'NOT_FOUND'))

    device.status = 'DEACTIVATED'
    device.deactivatedBy = req.staffUser._id
    device.deactivatedReason = reason
    await device.save()

    await auditLog.record(req, {
      action: 'DEVICE_DEACTIVATED',
      entityType: 'Device',
      entityId: device._id,
      newValue: { reason },
    })

    res.json({ success: true, message: 'Device deactivated', data: { device } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listDevices, registerDevice, deactivateDevice }
