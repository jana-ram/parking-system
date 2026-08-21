const ShiftInstance = require('../models/ShiftInstance')
const { createError } = require('../utils/helpers')

/**
 * shiftCheck — staff cannot perform sensitive parking operations without an
 * active shift (§14), full stop — no override built in here; the documented
 * admin-override escape hatch (§14) is a separate, explicitly audited path,
 * not a bypass flag on this middleware. Must run after protect() + deviceCheck
 * (needs req.staffUser and req.device). Attaches the OPEN ShiftInstance as
 * req.shiftInstance for the controller to stamp onto whatever it creates.
 */
const shiftCheck = async (req, res, next) => {
  try {
    const shiftInstance = await ShiftInstance.findOne({
      organizationId: req.staffUser.organizationId,
      staffId: req.staffUser._id,
      deviceId: req.device._id,
      status: 'OPEN',
    })
    if (!shiftInstance) {
      return next(createError(403, 'Your shift is not active', null, 'SHIFT_NOT_ACTIVE'))
    }
    req.shiftInstance = shiftInstance
    next()
  } catch (err) {
    next(err)
  }
}

module.exports = shiftCheck
