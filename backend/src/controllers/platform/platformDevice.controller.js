const Device = require('../../models/Device')
const { createError } = require('../../utils/helpers')

// GET /platform/devices — cross-org registry (§T, §28). Same skipOrgScope
// pattern as platformLocation.controller.js.
const listDevices = async (req, res, next) => {
  try {
    const devices = await Device.find({})
      .setOptions({ skipOrgScope: true })
      .populate('organizationId', 'name code')
      .sort({ createdAt: -1 })
      .limit(500)
    res.json({ success: true, message: 'ok', data: { devices } })
  } catch (err) {
    next(err)
  }
}

// POST /platform/devices/:id/deactivate — platform-level force-deactivate
// (§28: "Admin can deactivate a device" — the Product Owner's equivalent
// power for support/abuse cases the tenant Org Admin can't reach themselves,
// e.g. a compromised device reported outside the tenant's own visibility).
const deactivateDevice = async (req, res, next) => {
  try {
    const { reason } = req.body
    const device = await Device.findOne({ _id: req.params.id }).setOptions({ skipOrgScope: true })
    if (!device) return next(createError(404, 'Device not found', null, 'NOT_FOUND'))

    device.status = 'DEACTIVATED'
    device.deactivatedReason = `[Platform] ${reason}`
    await device.save()

    res.json({ success: true, message: 'Device deactivated', data: { device } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listDevices, deactivateDevice }
