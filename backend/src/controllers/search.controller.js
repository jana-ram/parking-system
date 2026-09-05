const ParkingSession = require('../models/ParkingSession')
const Vehicle = require('../models/Vehicle')
const QrToken = require('../models/QrToken')
const LuggageOrder = require('../models/LuggageOrder')
const ParcelOrder = require('../models/ParcelOrder')
const StaffUser = require('../models/StaffUser')
const Payment = require('../models/Payment')
const LuggagePayment = require('../models/LuggagePayment')
const ParcelPayment = require('../models/ParcelPayment')
const { escapeRegex, createError } = require('../utils/helpers')

const RESULT_LIMIT = 20

/**
 * GET /search?q= — one query box across every module (§ platform brief:
 * "one search should search across all types... if the search matches
 * multiple types, show all matching results together"). Open to any
 * authenticated role, same as /sessions/search already is — this is a
 * lookup tool staff need at the counter, not a Manager-only report.
 *
 * Deliberately federates by running one regex query per collection in
 * parallel rather than a single cross-collection query (Mongo has no native
 * join-everything primitive, and these are five structurally different
 * schemas) — reuses the exact escapeRegex + case-insensitive partial-match
 * pattern session.controller.js's searchSessions already established, and
 * the same two-hop Vehicle/QrToken -> ParkingSession join that endpoint
 * uses, so a plate or token search behaves identically here.
 */
const globalSearch = async (req, res, next) => {
  try {
    const raw = (req.query.q || '').trim()
    if (!raw) return next(createError(422, 'q query param is required', null, 'VALIDATION_ERROR'))

    const organizationId = req.staffUser.organizationId
    const pattern = new RegExp(escapeRegex(raw), 'i')

    const [vehicleMatches, tokenMatches, luggageOrders, parcelOrders, staffMatches, parkingPayments, luggagePayments, parcelPayments] = await Promise.all([
      Vehicle.find({ organizationId, vehicleNumber: pattern }).select('_id').limit(RESULT_LIMIT),
      QrToken.find({ organizationId, tokenCode: pattern }).select('_id').limit(RESULT_LIMIT),
      LuggageOrder.find({ organizationId, $or: [{ orderCode: pattern }, { customerName: pattern }, { customerPhone: pattern }] })
        .select('orderCode customerName customerPhone status amountDueMinor amountPaidMinor').limit(RESULT_LIMIT),
      ParcelOrder.find({ organizationId, $or: [{ orderCode: pattern }, { senderName: pattern }, { senderPhone: pattern }, { receiverName: pattern }, { receiverPhone: pattern }] })
        .select('orderCode senderName receiverName receiverPhone status amountDueMinor amountPaidMinor').limit(RESULT_LIMIT),
      StaffUser.find({ organizationId, $or: [{ name: pattern }, { phone: pattern }] }).select('name phone role status').limit(RESULT_LIMIT),
      Payment.find({ organizationId, clientTransactionId: pattern }).select('clientTransactionId method amountMinor status parkingSessionId createdAt').limit(RESULT_LIMIT),
      LuggagePayment.find({ organizationId, clientTransactionId: pattern }).select('clientTransactionId method amountMinor status orderId createdAt').limit(RESULT_LIMIT),
      ParcelPayment.find({ organizationId, clientTransactionId: pattern }).select('clientTransactionId method amountMinor status orderId createdAt').limit(RESULT_LIMIT),
    ])

    const orConditions = []
    if (vehicleMatches.length) orConditions.push({ vehicleId: { $in: vehicleMatches.map((v) => v._id) } })
    if (tokenMatches.length) orConditions.push({ tokenId: { $in: tokenMatches.map((t) => t._id) } })
    const sessions = orConditions.length
      ? await ParkingSession.find({ organizationId, $or: orConditions })
        .sort({ entryAt: -1 })
        .limit(RESULT_LIMIT)
        // requireOrgScope doesn't filter populate() queries — `match` is
        // required on every one of these, not optional decoration.
        .populate({ path: 'vehicleId', select: 'vehicleNumber', match: { organizationId } })
        .populate({ path: 'tokenId', select: 'tokenCode', match: { organizationId } })
      : []

    const vehicles = sessions.map((s) => ({
      sessionId: s._id, vehicleNumber: s.vehicleId?.vehicleNumber ?? null, tokenCode: s.tokenId?.tokenCode ?? null,
      status: s.status, entryAt: s.entryAt, exitAt: s.exitAt, amountDueMinor: s.amountDueMinor, amountPaidMinor: s.amountPaidMinor,
    }))

    const transactions = [
      ...parkingPayments.map((p) => ({ module: 'PARKING', paymentId: p._id, refId: p.parkingSessionId, clientTransactionId: p.clientTransactionId, method: p.method, amountMinor: p.amountMinor, status: p.status, createdAt: p.createdAt })),
      ...luggagePayments.map((p) => ({ module: 'LUGGAGE', paymentId: p._id, refId: p.orderId, clientTransactionId: p.clientTransactionId, method: p.method, amountMinor: p.amountMinor, status: p.status, createdAt: p.createdAt })),
      ...parcelPayments.map((p) => ({ module: 'PARCEL', paymentId: p._id, refId: p.orderId, clientTransactionId: p.clientTransactionId, method: p.method, amountMinor: p.amountMinor, status: p.status, createdAt: p.createdAt })),
    ]

    const counts = { vehicles: vehicles.length, luggage: luggageOrders.length, parcel: parcelOrders.length, staff: staffMatches.length, transactions: transactions.length }

    res.json({
      success: true,
      message: 'ok',
      data: {
        query: raw,
        totalCount: Object.values(counts).reduce((a, b) => a + b, 0),
        counts,
        vehicles,
        luggage: luggageOrders,
        parcel: parcelOrders,
        staff: staffMatches,
        transactions,
      },
    })
  } catch (err) {
    next(err)
  }
}

module.exports = { globalSearch }
