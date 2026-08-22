const ShiftInstance = require('../models/ShiftInstance')
const ShiftTally = require('../models/ShiftTally')
const ShiftHandover = require('../models/ShiftHandover')
const shiftService = require('../services/shift.service')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

/** loadShift — attaches req.shift for /shifts/:id/* routes. */
const loadShift = async (req, res, next) => {
  try {
    const shift = await ShiftInstance.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!shift) return next(createError(404, 'Shift not found', null, 'NOT_FOUND'))
    req.shift = shift
    next()
  } catch (err) {
    next(err)
  }
}

/**
 * GET /shifts/current — [Phase 7 addition] lets the mobile app recover its
 * shift state after a restart without guessing: without this, the app would
 * have no way to tell "no shift yet" apart from "already have one, just
 * don't know its ID," and would either wrongly show the Start Shift screen
 * (hitting SHIFT_ALREADY_ACTIVE on submit) or have to remember the shift ID
 * locally in a way that can't survive a reinstall.
 */
const getCurrentShift = async (req, res, next) => {
  try {
    const shift = await ShiftInstance.findOne({
      organizationId: req.staffUser.organizationId, staffId: req.staffUser._id, deviceId: req.device._id, status: 'OPEN',
    })
    // §22 handover discovery: the incoming staff has no other way to learn a
    // handover is waiting for them — there's no push mechanism here, so this
    // is the one place the mobile app already polls (Home screen boot) that
    // can surface it. PENDING only; ACCEPTED/DISPUTED handovers are done.
    let pendingHandover = null
    if (shift) {
      pendingHandover = await ShiftHandover.findOne({
        organizationId: req.staffUser.organizationId, toShiftInstanceId: shift._id, status: 'PENDING',
      })
    }
    res.json({ success: true, message: 'ok', data: { shiftInstance: shift || null, pendingHandover } })
  } catch (err) {
    next(err)
  }
}

/**
 * GET /shifts/open?locationId=X — [handover UI addition] the outgoing staff
 * initiating a handover needs to pick WHICH open shift at their location is
 * the incoming one; nothing exposed that list before this. Deliberately
 * scoped to one location and OPEN status only — the exact set
 * initiateHandover's own validation already requires, so this can never
 * suggest a target the initiate call would then reject.
 */
const listOpenShiftsAtLocation = async (req, res, next) => {
  try {
    const { locationId } = req.query
    if (!locationId) return next(createError(422, 'locationId is required', null, 'VALIDATION_ERROR'))
    const shifts = await ShiftInstance.find({
      organizationId: req.staffUser.organizationId, locationId, status: 'OPEN',
    }).populate({ path: 'staffId', select: 'name role', match: { organizationId: req.staffUser.organizationId } }).sort({ openedAt: -1 })
    res.json({ success: true, message: 'ok', data: { shiftInstances: shifts } })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /shifts/start — the only shift endpoint Phase 3 built, kept as-is here.
 * Close/tally/handover/active-vehicle-carry-forward (below) are Phase 4.
 */
const startShift = async (req, res, next) => {
  try {
    const { locationId, openingCashMinor } = req.body

    const existing = await ShiftInstance.findOne({
      organizationId: req.staffUser.organizationId,
      staffId: req.staffUser._id,
      deviceId: req.device._id,
      status: 'OPEN',
    })
    if (existing) return next(createError(409, 'You already have an active shift', null, 'SHIFT_ALREADY_ACTIVE'))

    const shiftInstance = await ShiftInstance.create({
      organizationId: req.staffUser.organizationId,
      locationId,
      staffId: req.staffUser._id,
      deviceId: req.device._id,
      openingCashMinor: openingCashMinor || 0,
    })

    await auditLog.record(req, {
      action: 'SHIFT_STARTED', entityType: 'ShiftInstance', entityId: shiftInstance._id,
      newValue: { locationId, openingCashMinor }, locationId, shiftInstanceId: shiftInstance._id,
    })

    res.status(201).json({ success: true, message: 'Shift started', data: { shiftInstance } })
  } catch (err) {
    if (err.code === 11000) return next(createError(409, 'You already have an active shift', null, 'SHIFT_ALREADY_ACTIVE'))
    next(err)
  }
}

const closeShift = async (req, res, next) => {
  try {
    if (String(req.shift.staffId) !== String(req.staffUser._id)) {
      return next(createError(403, 'Only the staff member who owns this shift can close it', null, 'FORBIDDEN_ROLE'))
    }
    const { shiftInstance, tally, requiresApproval, anomaly } = await shiftService.closeShift({
      organizationId: req.staffUser.organizationId, staffUser: req.staffUser, shiftInstance: req.shift, body: req.body,
    })
    res.json({
      success: true, message: 'Shift closed',
      data: {
        shiftInstanceId: shiftInstance._id, status: shiftInstance.status,
        entriesCount: tally.entriesCount, exitsCount: tally.exitsCount,
        expectedCashMinor: tally.expectedCashMinor, expectedUpiMinor: tally.expectedUpiMinor, expectedCardMinor: tally.expectedCardMinor,
        actualCashMinor: tally.actualCashMinor, varianceMinor: tally.varianceMinor,
        requiresApproval, thresholdMinor: shiftService.MISMATCH_APPROVAL_THRESHOLD_MINOR,
        anomaly: anomaly ? { riskLevel: anomaly.riskLevel, riskScore: anomaly.riskScore, reasons: anomaly.reasons } : null,
      },
    })
  } catch (err) {
    next(err)
  }
}

const forceCloseShift = async (req, res, next) => {
  try {
    const { reason } = req.body
    const { shiftInstance, incident } = await shiftService.forceCloseShift({
      organizationId: req.staffUser.organizationId, actorStaffUser: req.staffUser, shiftInstance: req.shift, reason,
    })
    res.json({ success: true, message: 'Shift force-closed', data: { shiftInstance, incidentId: incident._id } })
  } catch (err) {
    next(err)
  }
}

const getTally = async (req, res, next) => {
  try {
    const tally = await ShiftTally.findOne({ organizationId: req.staffUser.organizationId, shiftInstanceId: req.shift._id })
    if (!tally) return next(createError(404, 'This shift has not been tallied yet', null, 'NOT_FOUND'))
    res.json({
      success: true, message: 'ok',
      data: { tally, requiresApproval: shiftService.requiresApproval(tally.varianceMinor) },
    })
  } catch (err) {
    next(err)
  }
}

/**
 * GET /shifts/:id/tally-preview — read-only. Reuses closeShift's own
 * computeTally() so staff can see the expected cash/UPI/card breakdown
 * BEFORE typing an actual count and submitting close, instead of only
 * finding out afterward (getTally above 404s until a ShiftTally exists,
 * which close() is what creates). Never persists a ShiftTally or touches
 * shiftInstance.status — actualCashMinor:0 is fine here since the preview
 * only needs the expected-* fields, not a variance.
 */
const getTallyPreview = async (req, res, next) => {
  try {
    const computed = await shiftService.computeTally({
      organizationId: req.staffUser.organizationId, shiftInstanceId: req.shift._id, actualCashMinor: 0,
    })
    res.json({ success: true, message: 'ok', data: { preview: computed } })
  } catch (err) {
    next(err)
  }
}

const approveTally = async (req, res, next) => {
  try {
    const tally = await ShiftTally.findOne({ organizationId: req.staffUser.organizationId, shiftInstanceId: req.shift._id })
    if (!tally) return next(createError(404, 'This shift has not been tallied yet', null, 'NOT_FOUND'))
    const approved = await shiftService.approveTally({ organizationId: req.staffUser.organizationId, staffUser: req.staffUser, tally })
    res.json({ success: true, message: 'Tally approved', data: { tally: approved } })
  } catch (err) {
    next(err)
  }
}

const initiateHandover = async (req, res, next) => {
  try {
    const isOwner = String(req.shift.staffId) === String(req.staffUser._id)
    const isManagerPlus = ['MANAGER', 'ORG_ADMIN'].includes(req.staffUser.role)
    if (!isOwner && !isManagerPlus) {
      return next(createError(403, 'Only the outgoing staff member, a Manager, or an Org Admin can initiate this handover', null, 'FORBIDDEN_ROLE'))
    }
    const handover = await shiftService.initiateHandover({
      organizationId: req.staffUser.organizationId, actorStaffUser: req.staffUser,
      fromShiftInstance: req.shift, toShiftInstanceId: req.body.toShiftInstanceId,
    })
    res.status(201).json({ success: true, message: 'Handover initiated', data: { handover } })
  } catch (err) {
    next(err)
  }
}

module.exports = { loadShift, getCurrentShift, listOpenShiftsAtLocation, startShift, closeShift, forceCloseShift, getTally, getTallyPreview, approveTally, initiateHandover }
