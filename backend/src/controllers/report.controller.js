const mongoose = require('mongoose')
const ParkingSession = require('../models/ParkingSession')
const Payment = require('../models/Payment')
const ShiftInstance = require('../models/ShiftInstance')
const ShiftTally = require('../models/ShiftTally')
const StaffUser = require('../models/StaffUser')
const Location = require('../models/Location')
const Correction = require('../models/Correction')
const { createError } = require('../utils/helpers')

// Minimal CSV writer — no new dependency for something this small (§34
// Report Export). Wraps a field in quotes and escapes embedded quotes only
// when needed, matching RFC 4180 closely enough for a spreadsheet import.
function toCsv(rows, columns) {
  const escape = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = columns.map((c) => escape(c.label)).join(',')
  const lines = rows.map((row) => columns.map((c) => escape(c.value(row))).join(','))
  return [header, ...lines].join('\n')
}

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
      // when a locationId filter is given, join through ParkingSession to
      // apply it; skip the (more expensive) $lookup entirely for the common
      // org-wide-report case where it isn't needed.
      Payment.aggregateScoped(req.staffUser.organizationId, [
        { $match: { createdAt: { $gte: fromDate, $lte: toDate }, status: 'PAID' } },
        ...(locationId ? [
          { $lookup: { from: 'parkingsessions', localField: 'parkingSessionId', foreignField: '_id', as: 'session' } },
          { $unwind: '$session' },
          { $match: { 'session.locationId': new mongoose.Types.ObjectId(locationId) } },
        ] : []),
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
async function buildStaffCollectionRows(req) {
  const { from, to, locationId } = req.query
  if (!from || !to) throw createError(422, 'from and to query params are required (ISO dates)', null, 'VALIDATION_ERROR')

  const fromDate = new Date(from)
  const toDate = new Date(to)
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw createError(422, 'from/to must be valid ISO dates', null, 'VALIDATION_ERROR')
  }

  const organizationId = req.staffUser.organizationId
  const shiftMatch = { organizationId, status: 'CLOSED', closedAt: { $gte: fromDate, $lte: toDate } }
  if (locationId) shiftMatch.locationId = locationId

  const shifts = await ShiftInstance.find(shiftMatch).sort({ closedAt: -1 })
  if (!shifts.length) return []

  const shiftIds = shifts.map((s) => s._id)
  const [tallies, staffDocs, locationDocs] = await Promise.all([
    ShiftTally.find({ organizationId, shiftInstanceId: { $in: shiftIds } }),
    StaffUser.find({ organizationId, _id: { $in: shifts.map((s) => s.staffId) } }).select('name phone'),
    Location.find({ organizationId, _id: { $in: shifts.map((s) => s.locationId) } }).select('name'),
  ])

  const tallyByShift = Object.fromEntries(tallies.map((t) => [String(t.shiftInstanceId), t]))
  const staffById = Object.fromEntries(staffDocs.map((s) => [String(s._id), s]))
  const locationById = Object.fromEntries(locationDocs.map((l) => [String(l._id), l]))

  return shifts.map((shift) => {
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
}

const getStaffCollection = async (req, res, next) => {
  try {
    const rows = await buildStaffCollectionRows(req)

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

// GET /reports/staff-collection/export — the §22/§34 drill-down's CSV
// export, same rows getStaffCollection's `shifts` array returns.
const exportStaffCollectionCsv = async (req, res, next) => {
  try {
    const rows = await buildStaffCollectionRows(req)

    const csv = toCsv(rows, [
      { label: 'Shift ID', value: (r) => r.shiftInstanceId },
      { label: 'Staff', value: (r) => r.staffName },
      { label: 'Location', value: (r) => r.locationName },
      { label: 'Opened At', value: (r) => r.openedAt?.toISOString?.() ?? r.openedAt },
      { label: 'Closed At', value: (r) => r.closedAt?.toISOString?.() ?? r.closedAt },
      { label: 'Entries', value: (r) => r.entriesCount },
      { label: 'Exits', value: (r) => r.exitsCount },
      { label: 'Expected Cash (minor)', value: (r) => r.expectedCashMinor },
      { label: 'Expected UPI (minor)', value: (r) => r.expectedUpiMinor },
      { label: 'Expected Card (minor)', value: (r) => r.expectedCardMinor },
      { label: 'Actual Cash (minor)', value: (r) => r.actualCashMinor },
      { label: 'Variance (minor)', value: (r) => r.varianceMinor },
      { label: 'Mismatch Reason', value: (r) => r.mismatchReason },
    ])

    res.set('Content-Type', 'text/csv')
    res.set('Content-Disposition', 'attachment; filename="staff-collection.csv"')
    res.send(csv)
  } catch (err) {
    next(err)
  }
}

/**
 * GET /reports/shifts/:id/transactions — the §22 "Total Collection ₹25,450
 * -> 326 transactions" drill-down: every session (with its payments) that
 * ran under a given shift, whether opened or closed during it.
 */
const getShiftTransactions = async (req, res, next) => {
  try {
    const organizationId = req.staffUser.organizationId
    const shift = await ShiftInstance.findOne({ _id: req.params.id, organizationId })
    if (!shift) return next(createError(404, 'Shift not found', null, 'NOT_FOUND'))

    const sessions = await ParkingSession.find({
      organizationId,
      $or: [{ entryShiftInstanceId: shift._id }, { exitShiftInstanceId: shift._id }],
    })
      .sort({ entryAt: -1 })
      .populate({ path: 'vehicleId', select: 'vehicleNumber', match: { organizationId } })

    const payments = await Payment.find({ organizationId, shiftInstanceId: shift._id })

    const paymentsBySession = {}
    for (const p of payments) {
      const key = String(p.parkingSessionId)
      ;(paymentsBySession[key] ??= []).push({
        id: p._id, method: p.method, status: p.status, amountMinor: p.amountMinor,
        discountMinor: p.discountMinor, discountReason: p.discountReason, createdAt: p.createdAt,
      })
    }

    const transactions = sessions.map((s) => ({
      sessionId: s._id, vehicleNumber: s.vehicleId?.vehicleNumber ?? null, status: s.status,
      entryAt: s.entryAt, exitAt: s.exitAt, amountDueMinor: s.amountDueMinor, amountPaidMinor: s.amountPaidMinor,
      payments: paymentsBySession[String(s._id)] || [],
    }))

    res.json({ success: true, message: 'ok', data: { shiftInstanceId: shift._id, count: transactions.length, transactions } })
  } catch (err) {
    next(err)
  }
}

/**
 * GET /reports/corrections?from=&to=&entityType= — §22's "Audit" report
 * category (manual amount changes, alongside refunds/cancellations which
 * already surface via /audit-logs). Straight read of the Correction ledger
 * every override-amount action (§12) writes to.
 */
const getCorrections = async (req, res, next) => {
  try {
    const { from, to, entityType } = req.query
    const filter = { organizationId: req.staffUser.organizationId }
    if (entityType) filter.entityType = entityType
    if (from || to) {
      filter.createdAt = {}
      if (from) filter.createdAt.$gte = new Date(from)
      if (to) filter.createdAt.$lte = new Date(to)
    }

    const corrections = await Correction.find(filter).sort({ createdAt: -1 }).limit(500)
      .populate({ path: 'requestedBy', select: 'name', match: { organizationId: req.staffUser.organizationId } })

    res.json({ success: true, message: 'ok', data: { corrections } })
  } catch (err) {
    next(err)
  }
}

module.exports = { getSummary, getStaffCollection, exportStaffCollectionCsv, getShiftTransactions, getCorrections }
