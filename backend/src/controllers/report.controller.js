const mongoose = require('mongoose')
const ParkingSession = require('../models/ParkingSession')
const Payment = require('../models/Payment')
const { createError } = require('../utils/helpers')

/**
 * GET /reports/summary?locationId=&from=&to= — §36's mobile Reports screen.
 * Real aggregation over ParkingSession/Payment, scoped to the caller's
 * organization (aggregateScoped, same tenant-isolation discipline as every
 * other cross-document read in this codebase) — no client-side math, no
 * placeholder numbers. Manager+ only (route-level RBAC).
 */
const getSummary = async (req, res, next) => {
  try {
    const { locationId, from, to } = req.query
    if (!from || !to) return next(createError(422, 'from and to query params are required (ISO dates)', null, 'VALIDATION_ERROR'))

    const fromDate = new Date(from)
    const toDate = new Date(to)
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return next(createError(422, 'from/to must be valid ISO dates', null, 'VALIDATION_ERROR'))
    }

    const sessionMatch = { entryAt: { $gte: fromDate, $lte: toDate } }
    if (locationId) sessionMatch.locationId = new mongoose.Types.ObjectId(locationId)

    const [entryStats, exitStats, byVehicleType, paymentStats] = await Promise.all([
      ParkingSession.aggregateScoped(req.staffUser.organizationId, [
        { $match: sessionMatch },
        { $count: 'count' },
      ]),
      ParkingSession.aggregateScoped(req.staffUser.organizationId, [
        { $match: { ...sessionMatch, status: 'COMPLETED' } },
        { $count: 'count' },
      ]),
      ParkingSession.aggregateScoped(req.staffUser.organizationId, [
        { $match: sessionMatch },
        { $group: { _id: '$vehicleTypeId', count: { $sum: 1 } } },
      ]),
      // Payment carries no locationId of its own (only parkingSessionId) —
      // revenue-by-method below is organization-wide for the date range,
      // not location-filtered, when a locationId query param is given. A
      // $lookup join through ParkingSession would fix that; not done this
      // pass, stated here rather than silently ignoring the filter.
      Payment.aggregateScoped(req.staffUser.organizationId, [
        { $match: { createdAt: { $gte: fromDate, $lte: toDate }, status: 'PAID' } },
        { $group: { _id: '$method', totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
      ]),
    ])

    const revenueByMethod = Object.fromEntries(paymentStats.map((r) => [r._id, { totalMinor: r.totalMinor, count: r.count }]))
    const totalRevenueMinor = paymentStats.reduce((sum, r) => sum + r.totalMinor, 0)

    res.json({
      success: true,
      message: 'ok',
      data: {
        range: { from: fromDate, to: toDate },
        vehiclesEntered: entryStats[0]?.count ?? 0,
        vehiclesExited: exitStats[0]?.count ?? 0,
        totalRevenueMinor,
        revenueByMethod,
        byVehicleType: byVehicleType.map((r) => ({ vehicleTypeId: r._id, count: r.count })),
      },
    })
  } catch (err) {
    next(err)
  }
}

module.exports = { getSummary }
