const ParkingSession = require('../models/ParkingSession')
const Vehicle = require('../models/Vehicle')
const QrToken = require('../models/QrToken')
const Payment = require('../models/Payment')
const sessionService = require('../services/session.service')
const { escapeRegex, createError } = require('../utils/helpers')

/**
 * GET /sessions/by-token/:tokenCode — [Phase 7 addition] the mobile Scan &
 * Exit flow (§12) only ever has a token CODE in hand (staff scan/enter it),
 * but POST /sessions/:id/exit/request needs a session ID in the URL — this
 * bridges the two. Without it, the exit screen would have no way to resolve
 * "this token" into "this session" at all.
 */
const findSessionByTokenCode = async (req, res, next) => {
  try {
    const token = await QrToken.findOne({ organizationId: req.staffUser.organizationId, tokenCode: req.params.tokenCode })
    if (!token || !token.currentSessionId) {
      return next(createError(404, 'No active session found for this token', null, 'NOT_FOUND'))
    }
    // populate()'s underlying query has no organizationId filter by default —
    // requireOrgScope would correctly block it the same way it blocked the
    // Phase 3/5 bugs documented elsewhere in this codebase, so `match` is
    // required here, not optional decoration.
    const session = await ParkingSession.findOne({ organizationId: req.staffUser.organizationId, _id: token.currentSessionId })
      .populate({ path: 'vehicleId', select: 'vehicleNumber', match: { organizationId: req.staffUser.organizationId } })
    if (!session) return next(createError(404, 'No active session found for this token', null, 'NOT_FOUND'))
    res.json({ success: true, message: 'ok', data: { session } })
  } catch (err) {
    next(err)
  }
}

/**
 * loadSession — attaches req.session for /sessions/:id/* routes, BEFORE
 * locationCheck runs (it needs req.session.locationId to know which
 * geofence to check against — a session can only be exited at the location
 * it was entered at, there's no cross-location exit in this MVP).
 */
const loadSession = async (req, res, next) => {
  try {
    const session = await ParkingSession.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!session) return next(createError(404, 'Parking session not found', null, 'NOT_FOUND'))
    req.session = session
    next()
  } catch (err) {
    next(err)
  }
}

const enterVehicle = async (req, res, next) => {
  try {
    const { statusCode, session } = await sessionService.enterVehicle({
      organizationId: req.staffUser.organizationId,
      staffUser: req.staffUser,
      device: req.device,
      shiftInstance: req.shiftInstance,
      body: req.body,
    })
    res.status(statusCode).json({
      success: true,
      message: statusCode === 201 ? 'Vehicle parked' : 'Already processed',
      data: { sessionId: session._id, status: session.status, tokenId: session.tokenId, pricingRuleVersionId: session.pricingRuleVersionId, amountDueMinor: session.amountDueMinor, exitRequired: session.exitRequired },
    })
  } catch (err) {
    next(err)
  }
}

const requestExit = async (req, res, next) => {
  try {
    const { session, durationMinutes } = await sessionService.requestExit({
      organizationId: req.staffUser.organizationId,
      staffUser: req.staffUser,
      device: req.device,
      shiftInstance: req.shiftInstance,
      session: req.session,
      body: req.body,
    })
    res.json({
      success: true,
      message: session.status === 'COMPLETED' ? 'Exit complete' : 'Exit calculated',
      data: {
        sessionId: session._id, status: session.status, durationMinutes,
        amountDueMinor: session.amountDueMinor, amountPaidMinor: session.amountPaidMinor, currency: session.currency,
        entryAt: session.entryAt, exitAt: session.exitAt,
      },
    })
  } catch (err) {
    next(err)
  }
}

const recordPayment = async (req, res, next) => {
  try {
    const { statusCode, payment, session } = await sessionService.recordPayment({
      organizationId: req.staffUser.organizationId,
      staffUser: req.staffUser,
      device: req.device,
      shiftInstance: req.shiftInstance,
      session: req.session,
      body: req.body,
    })
    res.status(statusCode).json({
      success: true,
      message: 'Payment recorded',
      data: { paymentId: payment._id, status: payment.status, sessionStatus: session.status, discountMinor: payment.discountMinor },
    })
  } catch (err) {
    next(err)
  }
}

const cancelSession = async (req, res, next) => {
  try {
    const session = await sessionService.cancelSession({
      organizationId: req.staffUser.organizationId,
      staffUser: req.staffUser,
      device: req.device,
      session: req.session,
      reason: req.body.reason,
    })
    res.json({ success: true, message: 'Session cancelled', data: { sessionId: session._id, status: session.status } })
  } catch (err) {
    next(err)
  }
}

const listActiveSessions = async (req, res, next) => {
  try {
    const filter = { organizationId: req.staffUser.organizationId, status: { $nin: ParkingSession.TERMINAL_STATUSES } }
    if (req.query.locationId) filter.locationId = req.query.locationId
    const sessions = await ParkingSession.find(filter).sort({ entryAt: -1 }).limit(200)
    res.json({ success: true, message: 'ok', data: { sessions } })
  } catch (err) {
    next(err)
  }
}

/**
 * GET /sessions/search?q= — partial, case-insensitive match against EITHER
 * the vehicle number OR the QR/parking token code (same field, tokenCode —
 * there's only one token identifier in this schema). Previously matched
 * vehicleNumber only, and only exactly (normalizeVehicleNumber + findOne) —
 * a query like "AB12" against a stored "TN45AB1234" returned nothing, which
 * was the actual "vehicle search isn't working" bug. Also the shared data
 * source for the History screen, so results carry staff names and a payment
 * summary, not just bare session docs.
 */
const searchSessions = async (req, res, next) => {
  try {
    const raw = (req.query.q || req.query.vehicleNumber || '').trim()
    if (!raw) return next(createError(422, 'q query param is required', null, 'VALIDATION_ERROR'))

    const organizationId = req.staffUser.organizationId
    const pattern = new RegExp(escapeRegex(raw), 'i')

    const [vehicles, tokens] = await Promise.all([
      Vehicle.find({ organizationId, vehicleNumber: pattern }).select('_id').limit(200),
      QrToken.find({ organizationId, tokenCode: pattern }).select('_id').limit(200),
    ])

    const orConditions = []
    if (vehicles.length) orConditions.push({ vehicleId: { $in: vehicles.map((v) => v._id) } })
    if (tokens.length) orConditions.push({ tokenId: { $in: tokens.map((t) => t._id) } })
    if (!orConditions.length) return res.json({ success: true, message: 'ok', data: { sessions: [] } })

    const sessions = await ParkingSession.find({ organizationId, $or: orConditions })
      .sort({ entryAt: -1 })
      .limit(50)
      // requireOrgScope doesn't filter populate() queries (see
      // findSessionByTokenCode above) — `match` is required on every one of
      // these, not optional decoration.
      .populate({ path: 'vehicleId', select: 'vehicleNumber', match: { organizationId } })
      .populate({ path: 'tokenId', select: 'tokenCode', match: { organizationId } })
      .populate({ path: 'entryStaffId', select: 'name', match: { organizationId } })
      .populate({ path: 'exitStaffId', select: 'name', match: { organizationId } })

    const payments = await Payment.find({
      organizationId,
      parkingSessionId: { $in: sessions.map((s) => s._id) },
      status: { $in: ['PAID', 'PARTIALLY_PAID'] },
    }).select('parkingSessionId method amountMinor status')

    const paymentsBySession = {}
    for (const p of payments) {
      const key = String(p.parkingSessionId)
      ;(paymentsBySession[key] ??= []).push({ method: p.method, amountMinor: p.amountMinor, status: p.status })
    }

    const results = sessions.map((s) => ({ ...s.toObject(), payments: paymentsBySession[String(s._id)] || [] }))
    res.json({ success: true, message: 'ok', data: { sessions: results } })
  } catch (err) {
    next(err)
  }
}

module.exports = { loadSession, findSessionByTokenCode, enterVehicle, requestExit, recordPayment, cancelSession, listActiveSessions, searchSessions }
