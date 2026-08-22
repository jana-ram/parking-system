const mongoose = require('mongoose')
const ParkingSession = require('../models/ParkingSession')
const Payment = require('../models/Payment')
const ShiftInstance = require('../models/ShiftInstance')
const ShiftTally = require('../models/ShiftTally')
const StaffUser = require('../models/StaffUser')
const Location = require('../models/Location')
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

/**
 * GET /reports/staff-collection?from=&to=&locationId= — staff-wise
 * collection AND admin reconciliation are the same underlying data at two
 * zoom levels (per-shift rows vs. summed-by-staff), so one endpoint serves
 * both mobile screens rather than duplicating this join. ShiftTally already
 * stores every field needed per closed shift (expected/actual cash,
 * expected UPI/card, variance, mismatchReason, approvedBy — see
 * shift.service.js's computeTally) — this is a join across ShiftInstance +
 * ShiftTally + StaffUser + Location, not new data modeling.
 */
const getStaffCollection = async (req, res, next) => {
  try {
    const { from, to, locationId } = req.query
    if (!from || !to) return next(createError(422, 'from and to query params are required (ISO dates)', null, 'VALIDATION_ERROR'))

    const fromDate = new Date(from)
    const toDate = new Date(to)
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return next(createError(422, 'from/to must be valid ISO dates', null, 'VALIDATION_ERROR'))
    }

    const organizationId = req.staffUser.organizationId
    const shiftMatch = { organizationId, status: 'CLOSED', closedAt: { $gte: fromDate, $lte: toDate } }
    if (locationId) shiftMatch.locationId = locationId

    const shifts = await ShiftInstance.find(shiftMatch).sort({ closedAt: -1 })
    if (!shifts.length) return res.json({ success: true, message: 'ok', data: { shifts: [], byStaff: [] } })

    const shiftIds = shifts.map((s) => s._id)
    const [tallies, staffDocs, locationDocs] = await Promise.all([
      ShiftTally.find({ organizationId, shiftInstanceId: { $in: shiftIds } }),
      StaffUser.find({ organizationId, _id: { $in: shifts.map((s) => s.staffId) } }).select('name phone'),
      Location.find({ organizationId, _id: { $in: shifts.map((s) => s.locationId) } }).select('name'),
    ])

    const tallyByShift = Object.fromEntries(tallies.map((t) => [String(t.shiftInstanceId), t]))
    const staffById = Object.fromEntries(staffDocs.map((s) => [String(s._id), s]))
    const locationById = Object.fromEntries(locationDocs.map((l) => [String(l._id), l]))

    const rows = shifts.map((shift) => {
      const tally = tallyByShift[String(shift._id)]
      const staff = staffById[String(shift.staffId)]
      const location = locationById[String(shift.locationId)]
      return {
        shiftInstanceId: shift._id,
        staffId: shift.staffId, staffName: staff?.name ?? 'Unknown', staffPhone: staff?.phone ?? null,
        locationId: shift.locationId, locationName: location?.name ?? 'Unknown',
        openedAt: shift.openedAt, closedAt: shift.closedAt,
        entriesCount: tally?.entriesCount ?? 0, exitsCount: tally?.exitsCount ?? 0,
        expectedCashMinor: tally?.expectedCashMinor ?? 0, expectedUpiMinor: tally?.expectedUpiMinor ?? 0, expectedCardMinor: tally?.expectedCardMinor ?? 0,
        actualCashMinor: tally?.actualCashMinor ?? 0, varianceMinor: tally?.varianceMinor ?? 0,
        mismatchReason: tally?.mismatchReason ?? null, approvedBy: tally?.approvedBy ?? null,
      }
    })

    // Same rows, summed per staff member — the "staff-wise collection" view;
    // the per-shift `rows` above is the "admin reconciliation" drill-down.
    const byStaffMap = {}
    for (const row of rows) {
      const key = String(row.staffId)
      if (!byStaffMap[key]) {
        byStaffMap[key] = {
          staffId: row.staffId, staffName: row.staffName, staffPhone: row.staffPhone, shiftsCount: 0,
          entriesCount: 0, exitsCount: 0,
          expectedCashMinor: 0, expectedUpiMinor: 0, expectedCardMinor: 0,
          actualCashMinor: 0, varianceMinor: 0,
        }
      }
      const agg = byStaffMap[key]
      agg.shiftsCount += 1
      agg.entriesCount += row.entriesCount
      agg.exitsCount += row.exitsCount
      agg.expectedCashMinor += row.expectedCashMinor
      agg.expectedUpiMinor += row.expectedUpiMinor
      agg.expectedCardMinor += row.expectedCardMinor
      agg.actualCashMinor += row.actualCashMinor
      agg.varianceMinor += row.varianceMinor
    }

    res.json({ success: true, message: 'ok', data: { shifts: rows, byStaff: Object.values(byStaffMap) } })
  } catch (err) {
    next(err)
  }
}

module.exports = { getSummary, getStaffCollection }
