const mongoose = require('mongoose')
const ExcelJS = require('exceljs')
const RackSlot = require('../models/RackSlot')
const ParkingSession = require('../models/ParkingSession')
const Payment = require('../models/Payment')
const ShiftInstance = require('../models/ShiftInstance')
const ShiftTally = require('../models/ShiftTally')
const StaffUser = require('../models/StaffUser')
const Location = require('../models/Location')
const Correction = require('../models/Correction')
const LuggageOrder = require('../models/LuggageOrder')
const LuggagePayment = require('../models/LuggagePayment')
const ParcelOrder = require('../models/ParcelOrder')
const ParcelPayment = require('../models/ParcelPayment')
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

// §6/§34: real .xlsx generation via exceljs (server-side — no native/mobile
// risk, and specifically NOT the `xlsx`/SheetJS package, which was already
// evaluated and rejected earlier for an unpatched high-severity vulnerability,
// GHSA-4r6h-8v6p-xvw6). Reuses the exact same `columns` definitions every CSV
// export already has — one `{label, value(row)}` list serializes to both
// formats, so the two never drift out of sync with each other.
async function toXlsxBuffer(rows, columns, sheetName = 'Sheet1') {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(sheetName)
  sheet.columns = columns.map((c) => ({ header: c.label, key: c.label, width: Math.max(12, c.label.length + 4) }))
  sheet.getRow(1).font = { bold: true }
  for (const row of rows) {
    sheet.addRow(columns.map((c) => c.value(row)))
  }
  return workbook.xlsx.writeBuffer()
}

function sendXlsx(res, buffer, filename) {
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.set('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(Buffer.from(buffer))
}

// req.query.format === 'xlsx' opts into a real spreadsheet instead of CSV on
// every export endpoint below — same rows/columns either way.
function wantsXlsx(req) {
  return req.query.format === 'xlsx'
}

// Merges N `{ _id: method, totalMinor, count }` aggregation result arrays
// (one per revenue source — Payment/LuggagePayment/ParcelPayment) into one
// by-method map, so "everything, every type, in one place" (per the
// platform brief) doesn't mean re-deriving totals client-side from three
// separate calls.
function mergeByMethod(...resultSets) {
  const merged = {}
  for (const rows of resultSets) {
    for (const r of rows) {
      const bucket = (merged[r._id] ??= { totalMinor: 0, count: 0 })
      bucket.totalMinor += r.totalMinor
      bucket.count += r.count
    }
  }
  return merged
}

/**
 * GET /reports/summary?locationId=&from=&to= — §22/§36: revenue and volume
 * across EVERY module (Parking, Luggage, Parcel), not just Parking — a
 * per-type breakdown alongside the combined total so "show everything" and
 * "show it clearly per type" are both true of the same response, not a
 * tradeoff. Manager+ only (route-level RBAC).
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

    const organizationId = req.staffUser.organizationId
    const locationObjectId = locationId ? new mongoose.Types.ObjectId(locationId) : null
    const sessionMatch = { entryAt: { $gte: fromDate, $lte: toDate } }
    if (locationObjectId) sessionMatch.locationId = locationObjectId

    const now = new Date()
    const [
      entryStats, exitStats, byVehicleType, parkingPaymentStats,
      luggagePaymentStats, luggageOrderCounts, luggageOverdueStats,
      parcelPaymentStats, parcelOrderCounts, parcelOverdueStats,
      parkingCancelledStats, parkingRefundStats, luggageRefundStats, parcelRefundStats, rackSlotStats,
    ] = await Promise.all([
      ParkingSession.aggregateScoped(organizationId, [{ $match: sessionMatch }, { $count: 'count' }]),
      // Exit count must key off exitAt, not entryAt (sessionMatch) — a
      // vehicle that entered yesterday and exits today was previously
      // invisible to both days' "Exited" count (and would wrongly count
      // under yesterday's range once it did exit). This now matches how
      // ShiftTally's entriesCount/exitsCount are already correctly split by
      // which shift the event happened in (shift.service.js:46-47).
      ParkingSession.aggregateScoped(organizationId, [
        { $match: { exitAt: { $gte: fromDate, $lte: toDate }, status: 'COMPLETED', ...(locationObjectId ? { locationId: locationObjectId } : {}) } },
        { $count: 'count' },
      ]),
      ParkingSession.aggregateScoped(organizationId, [{ $match: sessionMatch }, { $group: { _id: '$vehicleTypeId', count: { $sum: 1 } } }]),
      // Payment carries no locationId of its own (only parkingSessionId) —
      // when a locationId filter is given, join through ParkingSession to
      // apply it; skip the (more expensive) $lookup entirely for the common
      // org-wide-report case where it isn't needed.
      // PARTIALLY_PAID is real cash/UPI/card already collected on a session
      // not yet fully settled — excluding it (as this did before) undercounts
      // actual revenue relative to Staff Collection's tally, which already
      // includes it (shift.service.js's computeTally, `$in: ['PAID','PARTIALLY_PAID']`).
      Payment.aggregateScoped(organizationId, [
        { $match: { createdAt: { $gte: fromDate, $lte: toDate }, status: { $in: ['PAID', 'PARTIALLY_PAID'] } } },
        ...(locationObjectId ? [
          { $lookup: { from: 'parkingsessions', localField: 'parkingSessionId', foreignField: '_id', as: 'session' } },
          { $unwind: '$session' },
          { $match: { 'session.locationId': locationObjectId } },
        ] : []),
        { $group: { _id: '$method', totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
      ]),
      // status: 'PAID' — dormant today (no Luggage/Parcel refund flow exists
      // yet), added proactively so revenue doesn't start silently including
      // REFUNDED amounts the moment one ships, matching Parking's own filter.
      LuggagePayment.aggregateScoped(organizationId, [
        { $match: { createdAt: { $gte: fromDate, $lte: toDate }, status: 'PAID', ...(locationObjectId ? { locationId: locationObjectId } : {}) } },
        { $group: { _id: '$method', totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
      ]),
      // Live snapshot, not date-range-scoped — same reasoning as overdueCount
      // below and "Currently Parked": how many orders are ACTIVE/COMPLETED
      // right now shouldn't change just because the report's date filter
      // does (this previously counted orders CREATED in-range, grouped by
      // their CURRENT status, which made "Luggage Active" swing with the
      // date picker even though nothing about which orders are open changed).
      LuggageOrder.aggregateScoped(organizationId, [
        { $match: { ...(locationObjectId ? { locationId: locationObjectId } : {}) } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      LuggageOrder.aggregateScoped(organizationId, [
        { $match: { status: 'ACTIVE', expectedPickupAt: { $lt: now }, ...(locationObjectId ? { locationId: locationObjectId } : {}) } },
        { $count: 'count' },
      ]),
      ParcelPayment.aggregateScoped(organizationId, [
        { $match: { createdAt: { $gte: fromDate, $lte: toDate }, status: 'PAID', ...(locationObjectId ? { locationId: locationObjectId } : {}) } },
        { $group: { _id: '$method', totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
      ]),
      ParcelOrder.aggregateScoped(organizationId, [
        { $match: { ...(locationObjectId ? { locationId: locationObjectId } : {}) } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      ParcelOrder.aggregateScoped(organizationId, [
        { $match: { status: 'ACTIVE', expectedPickupAt: { $lt: now }, ...(locationObjectId ? { locationId: locationObjectId } : {}) } },
        { $count: 'count' },
      ]),
      // Cancelled Parking sessions were never counted anywhere in this
      // summary before — scoped by entryAt like "Entered", since a
      // cancellation is a variant of an entry event, not a separate one.
      ParkingSession.aggregateScoped(organizationId, [{ $match: { ...sessionMatch, status: 'CANCELLED' } }, { $count: 'count' }]),
      // Refunds — dormant today (no refund-issuing action exists anywhere in
      // the app yet for any module), added so the Reports screen has a real,
      // correctly-wired place to show them the moment a refund flow ships,
      // rather than needing new aggregation work added later.
      Payment.aggregateScoped(organizationId, [
        { $match: { createdAt: { $gte: fromDate, $lte: toDate }, status: 'REFUNDED' } },
        { $group: { _id: null, totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
      ]),
      LuggagePayment.aggregateScoped(organizationId, [
        { $match: { createdAt: { $gte: fromDate, $lte: toDate }, status: 'REFUNDED', ...(locationObjectId ? { locationId: locationObjectId } : {}) } },
        { $group: { _id: null, totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
      ]),
      ParcelPayment.aggregateScoped(organizationId, [
        { $match: { createdAt: { $gte: fromDate, $lte: toDate }, status: 'REFUNDED', ...(locationObjectId ? { locationId: locationObjectId } : {}) } },
        { $group: { _id: null, totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
      ]),
      // Rack occupancy — a live snapshot (like "Currently Parked"), not
      // date-range-scoped: how many slots are occupied right now doesn't
      // depend on the report's date filter.
      RackSlot.aggregateScoped(organizationId, [
        { $match: { ...(locationObjectId ? { locationId: locationObjectId } : {}) } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ])

    const totalOf = (rows) => rows.reduce((sum, r) => sum + r.totalMinor, 0)
    const countsOf = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.count]))
    const parkingRevenueMinor = totalOf(parkingPaymentStats)
    const luggageRevenueMinor = totalOf(luggagePaymentStats)
    const parcelRevenueMinor = totalOf(parcelPaymentStats)

    res.json({
      success: true,
      message: 'ok',
      data: {
        range: { from: fromDate, to: toDate },
        // Combined, across every module — the top-line "everything" figure.
        totalRevenueMinor: parkingRevenueMinor + luggageRevenueMinor + parcelRevenueMinor,
        revenueByMethod: mergeByMethod(parkingPaymentStats, luggagePaymentStats, parcelPaymentStats),
        // Per-type breakdown — the same total, never hidden behind a single
        // number. Each module also carries its OWN revenueByMethod (not just
        // the merged top-level one) so a client-side "Parking / Luggage /
        // Parcel" report filter can switch what it displays without a
        // separate round-trip per type.
        byModule: {
          parking: {
            revenueMinor: parkingRevenueMinor, vehiclesEntered: entryStats[0]?.count ?? 0, vehiclesExited: exitStats[0]?.count ?? 0,
            cancelledCount: parkingCancelledStats[0]?.count ?? 0, refundsMinor: parkingRefundStats[0]?.totalMinor ?? 0, refundsCount: parkingRefundStats[0]?.count ?? 0,
            revenueByMethod: mergeByMethod(parkingPaymentStats),
          },
          luggage: {
            revenueMinor: luggageRevenueMinor, orders: countsOf(luggageOrderCounts), overdueCount: luggageOverdueStats[0]?.count ?? 0,
            refundsMinor: luggageRefundStats[0]?.totalMinor ?? 0, refundsCount: luggageRefundStats[0]?.count ?? 0,
            revenueByMethod: mergeByMethod(luggagePaymentStats),
          },
          parcel: {
            revenueMinor: parcelRevenueMinor, orders: countsOf(parcelOrderCounts), overdueCount: parcelOverdueStats[0]?.count ?? 0,
            refundsMinor: parcelRefundStats[0]?.totalMinor ?? 0, refundsCount: parcelRefundStats[0]?.count ?? 0,
            revenueByMethod: mergeByMethod(parcelPaymentStats),
          },
        },
        // A live snapshot of rack slot status (like "Currently Parked"),
        // present even when RACK is disabled (just all-zero) — see
        // RackSlot.aggregateScoped's header comment above.
        rackOccupancy: countsOf(rackSlotStats),
        // Kept at top level too — existing callers (mobile ReportsScreen)
        // already read these two fields directly.
        vehiclesEntered: entryStats[0]?.count ?? 0,
        vehiclesExited: exitStats[0]?.count ?? 0,
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
    const columns = [
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
    ]

    if (wantsXlsx(req)) {
      const buffer = await toXlsxBuffer(rows, columns, 'Staff Collection')
      return sendXlsx(res, buffer, 'staff-collection.xlsx')
    }
    res.set('Content-Type', 'text/csv')
    res.set('Content-Disposition', 'attachment; filename="staff-collection.csv"')
    res.send(toCsv(rows, columns))
  } catch (err) {
    next(err)
  }
}

/**
 * GET /reports/shifts/:id/transactions — the §22 "Total Collection ₹25,450
 * -> 326 transactions" drill-down: every session (with its payments) that
 * ran under a given shift, whether opened or closed during it. Also pulls in
 * every Luggage/Parcel payment recorded under the same shift — cash for a
 * luggage/parcel pickup is just as much "this shift's money" as a parking
 * payment (see shift.service.js's computeTally, which now reconciles it the
 * same way), so leaving it out here would make the drill-down disagree with
 * the tally it's supposed to explain.
 */
async function buildShiftTransactions(req) {
  const organizationId = req.staffUser.organizationId
  const shift = await ShiftInstance.findOne({ _id: req.params.id, organizationId })
  if (!shift) throw createError(404, 'Shift not found', null, 'NOT_FOUND')

  const [sessions, payments, luggagePayments, parcelPayments] = await Promise.all([
    ParkingSession.find({
      organizationId,
      $or: [{ entryShiftInstanceId: shift._id }, { exitShiftInstanceId: shift._id }],
    })
      .sort({ entryAt: -1 })
      .populate({ path: 'vehicleId', select: 'vehicleNumber', match: { organizationId } }),
    Payment.find({ organizationId, shiftInstanceId: shift._id }),
    LuggagePayment.find({ organizationId, shiftInstanceId: shift._id }).populate({ path: 'orderId', select: 'orderCode customerName', match: { organizationId } }),
    ParcelPayment.find({ organizationId, shiftInstanceId: shift._id }).populate({ path: 'orderId', select: 'orderCode receiverName', match: { organizationId } }),
  ])

  const paymentsBySession = {}
  for (const p of payments) {
    const key = String(p.parkingSessionId)
    ;(paymentsBySession[key] ??= []).push({
      id: p._id, method: p.method, status: p.status, amountMinor: p.amountMinor,
      discountMinor: p.discountMinor, discountReason: p.discountReason, createdAt: p.createdAt,
    })
  }

  const parkingTransactions = sessions.map((s) => ({
    module: 'PARKING', sessionId: s._id, vehicleNumber: s.vehicleId?.vehicleNumber ?? null, status: s.status,
    entryAt: s.entryAt, exitAt: s.exitAt, amountDueMinor: s.amountDueMinor, amountPaidMinor: s.amountPaidMinor,
    payments: paymentsBySession[String(s._id)] || [],
  }))

  const luggageTransactions = luggagePayments.map((p) => ({
    module: 'LUGGAGE', orderId: p.orderId?._id ?? null, orderCode: p.orderId?.orderCode ?? null, customerName: p.orderId?.customerName ?? null,
    method: p.method, status: p.status, amountMinor: p.amountMinor, createdAt: p.createdAt,
  }))

  const parcelTransactions = parcelPayments.map((p) => ({
    module: 'PARCEL', orderId: p.orderId?._id ?? null, orderCode: p.orderId?.orderCode ?? null, receiverName: p.orderId?.receiverName ?? null,
    method: p.method, status: p.status, amountMinor: p.amountMinor, createdAt: p.createdAt,
  }))

  return { shiftInstanceId: shift._id, parkingTransactions, luggageTransactions, parcelTransactions }
}

const getShiftTransactions = async (req, res, next) => {
  try {
    const { shiftInstanceId, parkingTransactions, luggageTransactions, parcelTransactions } = await buildShiftTransactions(req)
    res.json({
      success: true,
      message: 'ok',
      data: {
        shiftInstanceId,
        count: parkingTransactions.length + luggageTransactions.length + parcelTransactions.length,
        // `transactions` kept as the existing field name (Parking-only) so
        // current callers reading it directly don't silently change shape;
        // the two new arrays are additive.
        transactions: parkingTransactions,
        luggageTransactions,
        parcelTransactions,
      },
    })
  } catch (err) {
    next(err)
  }
}

// GET /reports/shifts/:id/transactions/export — CSV of the same combined
// per-shift drill-down, one row per transaction across all three modules.
const exportShiftTransactionsCsv = async (req, res, next) => {
  try {
    const { parkingTransactions, luggageTransactions, parcelTransactions } = await buildShiftTransactions(req)

    const rows = [
      ...parkingTransactions.flatMap((t) => (t.payments.length ? t.payments.map((p) => ({ ...t, ...p, paymentAmountMinor: p.amountMinor })) : [{ ...t, paymentAmountMinor: null, method: null }])),
      ...luggageTransactions.map((t) => ({ ...t, paymentAmountMinor: t.amountMinor })),
      ...parcelTransactions.map((t) => ({ ...t, paymentAmountMinor: t.amountMinor })),
    ]

    const columns = [
      { label: 'Module', value: (r) => r.module },
      { label: 'Reference', value: (r) => r.vehicleNumber ?? r.orderCode ?? r.sessionId ?? '' },
      { label: 'Customer', value: (r) => r.customerName ?? r.receiverName ?? '' },
      { label: 'Method', value: (r) => r.method ?? '' },
      { label: 'Status', value: (r) => r.status ?? '' },
      { label: 'Amount (minor units)', value: (r) => r.paymentAmountMinor ?? '' },
      { label: 'Amount', value: (r) => (r.paymentAmountMinor != null ? (r.paymentAmountMinor / 100).toFixed(2) : '') },
      { label: 'Recorded At', value: (r) => r.createdAt?.toISOString?.() ?? r.createdAt ?? '' },
    ]

    if (wantsXlsx(req)) {
      const buffer = await toXlsxBuffer(rows, columns, 'Shift Transactions')
      return sendXlsx(res, buffer, 'shift-transactions.xlsx')
    }
    res.set('Content-Type', 'text/csv')
    res.set('Content-Disposition', 'attachment; filename="shift-transactions.csv"')
    res.send(toCsv(rows, columns))
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

// GET /reports/corrections/export — CSV of the same manual-override audit
// trail getCorrections returns.
const exportCorrectionsCsv = async (req, res, next) => {
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

    const columns = [
      { label: 'Entity Type', value: (r) => r.entityType },
      { label: 'Entity ID', value: (r) => r.entityId },
      { label: 'Field', value: (r) => r.field },
      { label: 'Old Value', value: (r) => r.oldValue },
      { label: 'New Value', value: (r) => r.newValue },
      { label: 'Reason', value: (r) => r.reason },
      { label: 'Requested By', value: (r) => r.requestedBy?.name ?? '' },
      { label: 'Recorded At', value: (r) => r.createdAt?.toISOString?.() ?? r.createdAt },
    ]

    if (wantsXlsx(req)) {
      const buffer = await toXlsxBuffer(corrections, columns, 'Corrections')
      return sendXlsx(res, buffer, 'corrections.xlsx')
    }
    res.set('Content-Type', 'text/csv')
    res.set('Content-Disposition', 'attachment; filename="corrections.csv"')
    res.send(toCsv(corrections, columns))
  } catch (err) {
    next(err)
  }
}

// GET /reports/summary/export?from=&to=&locationId= — CSV of the same
// §22/§36 "everything, every type" breakdown getSummary returns, one row
// per module plus a combined total, so the export matches what's on screen.
const exportSummaryCsv = async (req, res, next) => {
  try {
    let summary
    await new Promise((resolve, reject) => {
      getSummary(req, { json: (body) => { summary = body.data; resolve() } }, reject)
    })

    const rows = [
      { module: 'Parking', revenueMinor: summary.byModule.parking.revenueMinor, detail: `${summary.byModule.parking.vehiclesEntered} entered / ${summary.byModule.parking.vehiclesExited} exited / ${summary.byModule.parking.cancelledCount} cancelled`, refundsMinor: summary.byModule.parking.refundsMinor },
      { module: 'Luggage', revenueMinor: summary.byModule.luggage.revenueMinor, detail: `${JSON.stringify(summary.byModule.luggage.orders)} · ${summary.byModule.luggage.overdueCount} overdue`, refundsMinor: summary.byModule.luggage.refundsMinor },
      { module: 'Parcel', revenueMinor: summary.byModule.parcel.revenueMinor, detail: `${JSON.stringify(summary.byModule.parcel.orders)} · ${summary.byModule.parcel.overdueCount} overdue`, refundsMinor: summary.byModule.parcel.refundsMinor },
      { module: 'Rack (live)', revenueMinor: null, detail: JSON.stringify(summary.rackOccupancy), refundsMinor: null },
      { module: 'TOTAL', revenueMinor: summary.totalRevenueMinor, detail: '', refundsMinor: summary.byModule.parking.refundsMinor + summary.byModule.luggage.refundsMinor + summary.byModule.parcel.refundsMinor },
    ]

    const columns = [
      { label: 'Module', value: (r) => r.module },
      { label: 'Revenue (minor units)', value: (r) => r.revenueMinor ?? '' },
      { label: 'Revenue', value: (r) => (r.revenueMinor != null ? (r.revenueMinor / 100).toFixed(2) : '') },
      { label: 'Refunds', value: (r) => (r.refundsMinor != null ? (r.refundsMinor / 100).toFixed(2) : '') },
      { label: 'Detail', value: (r) => r.detail },
    ]

    if (wantsXlsx(req)) {
      const buffer = await toXlsxBuffer(rows, columns, 'Summary')
      return sendXlsx(res, buffer, 'summary-report.xlsx')
    }
    res.set('Content-Type', 'text/csv')
    res.set('Content-Disposition', 'attachment; filename="summary-report.csv"')
    res.send(toCsv(rows, columns))
  } catch (err) {
    next(err)
  }
}

module.exports = {
  getSummary, exportSummaryCsv, getStaffCollection, exportStaffCollectionCsv,
  getShiftTransactions, exportShiftTransactionsCsv, getCorrections, exportCorrectionsCsv,
}
