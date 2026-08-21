const ShiftHandover = require('../models/ShiftHandover')
const shiftService = require('../services/shift.service')
const { createError } = require('../utils/helpers')

const getHandover = async (req, res, next) => {
  try {
    const handover = await ShiftHandover.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!handover) return next(createError(404, 'Handover not found', null, 'NOT_FOUND'))
    res.json({ success: true, message: 'ok', data: { handover } })
  } catch (err) {
    next(err)
  }
}

const acceptHandover = async (req, res, next) => {
  try {
    const handover = await ShiftHandover.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!handover) return next(createError(404, 'Handover not found', null, 'NOT_FOUND'))

    const result = await shiftService.acceptHandover({
      organizationId: req.staffUser.organizationId, actorStaffUser: req.staffUser, handover,
    })
    res.json({ success: true, message: 'Handover accepted', data: { handover: result.handover } })
  } catch (err) {
    next(err)
  }
}

module.exports = { getHandover, acceptHandover }
