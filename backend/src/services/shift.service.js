const ShiftInstance = require('../models/ShiftInstance')
const ShiftTally = require('../models/ShiftTally')
const ShiftHandover = require('../models/ShiftHandover')
const ParkingSession = require('../models/ParkingSession')
const Payment = require('../models/Payment')
const QrToken = require('../models/QrToken')
const Incident = require('../models/Incident')
const shiftStateMachine = require('../domain/shiftStateMachine')
const tokenStateMachine = require('../domain/tokenStateMachine')
const auditLog = require('./auditLog.service')
const anomalyService = require('./anomaly.service')
const notificationService = require('./notification.service')
const { createError } = require('../utils/helpers')

// [Phase 4 scope note] Org-configurable per §15's worked example — not yet
// exposed via API (would live on Organization or a per-location settings
// doc); hardcoded here rather than invented as a fake "org settings" feature
// nobody asked for yet.
const MISMATCH_APPROVAL_THRESHOLD_MINOR = 10000 // ₹100 equivalent

function requiresApproval(varianceMinor) {
  return Math.abs(varianceMinor) > MISMATCH_APPROVAL_THRESHOLD_MINOR
}

/**
 * Cash/session tally — §15. Cash variance is the only physically-countable,
 * error-prone medium, so varianceMinor is cash-only (UPI/card are
 * electronically reconciled and don't need physical counting, matching the
 * §15 worked example). [Phase 4 scope note] discountsMinor/correctionsCount
 * are placeholder zeros — there is no discount/correction-recording feature
 * built yet (Corrections model exists but nothing writes to it yet); wiring
 * those in is separate, real work, not silently faked here as nonzero.
 */
async function computeTally({ organizationId, shiftInstanceId, actualCashMinor }) {
  const [entriesCount, exitsCount, cancellationsCount, paymentAgg, refundAgg] = await Promise.all([
    ParkingSession.countDocuments({ organizationId, entryShiftInstanceId: shiftInstanceId }),
    ParkingSession.countDocuments({ organizationId, exitShiftInstanceId: shiftInstanceId, status: 'COMPLETED' }),
    ParkingSession.countDocuments({ organizationId, entryShiftInstanceId: shiftInstanceId, status: 'CANCELLED' }),
    Payment.aggregateScoped(organizationId, [
      { $match: { shiftInstanceId, status: { $in: ['PAID', 'PARTIALLY_PAID'] } } },
      { $group: { _id: '$method', total: { $sum: '$amountMinor' } } },
    ]),
    Payment.aggregateScoped(organizationId, [
      { $match: { shiftInstanceId, status: 'REFUNDED' } },
      { $group: { _id: null, total: { $sum: '$amountMinor' } } },
    ]),
  ])

  const byMethod = Object.fromEntries(paymentAgg.map((r) => [r._id, r.total]))
  const expectedCashMinor = byMethod.CASH || 0
  const expectedUpiMinor = byMethod.UPI || 0
  // OTHER is folded into the card bucket — the schema has only three expected-*
  // fields (cash/upi/card), matching §15's worked example; a fourth "other"
  // bucket is a reasonable future addition, not done here without a concrete need.
  const expectedCardMinor = (byMethod.CARD || 0) + (byMethod.OTHER || 0)
  const refundsMinor = refundAgg[0]?.total || 0
  const varianceMinor = actualCashMinor - expectedCashMinor

  return {
    entriesCount, exitsCount, cancellationsCount, refundsMinor,
    expectedCashMinor, expectedUpiMinor, expectedCardMinor,
    discountsMinor: 0, correctionsCount: 0,
    actualCashMinor, varianceMinor,
  }
}

/**
 * closeShift — OPEN -> TALLY_PENDING -> CLOSED in one call (§H). A mismatch
 * requires a reason (§15: "never silently alter expected values") and, past
 * the threshold, is left unapproved for a Manager+ to sign off separately
 * (approveTally below) rather than auto-approving itself.
 */
async function closeShift({ organizationId, staffUser, shiftInstance, body }) {
  const { actualCashMinor, notes } = body

  shiftStateMachine.assertTransition(shiftInstance.status, 'TALLY_PENDING')
  shiftInstance.status = 'TALLY_PENDING'
  await shiftInstance.save()

  const computed = await computeTally({ organizationId, shiftInstanceId: shiftInstance._id, actualCashMinor })
  if (computed.varianceMinor !== 0 && !notes) {
    throw createError(422, 'A reason is required when actual cash does not match expected cash', null, 'VALIDATION_ERROR')
  }

  const tally = await ShiftTally.create({
    organizationId,
    shiftInstanceId: shiftInstance._id,
    ...computed,
    mismatchReason: computed.varianceMinor !== 0 ? notes : undefined,
  })

  shiftStateMachine.assertTransition('TALLY_PENDING', 'CLOSED')
  shiftInstance.status = 'CLOSED'
  shiftInstance.closedAt = new Date()
  await shiftInstance.save()

  await auditLog.recordSystem({
    organizationId, actorId: staffUser._id, actorRole: staffUser.role, actorName: staffUser.name,
    action: 'SHIFT_CLOSED', entityType: 'ShiftInstance', entityId: shiftInstance._id,
    newValue: { ...computed, requiresApproval: requiresApproval(computed.varianceMinor) },
    locationId: shiftInstance.locationId, shiftInstanceId: shiftInstance._id,
  })

  // §20/§R: score the shift for anomalies right where the complete picture
  // exists (cancellations + cash variance are already computed above; the
  // rest of the signals are gathered fresh), same "flag at the natural
  // completion point" pattern as riderAutoChecks.service.js in the sibling
  // product. Never blocks the close itself — a scoring failure shouldn't
  // stop a staff member from closing their shift.
  let anomaly = null
  try {
    anomaly = await anomalyService.scoreShiftAndFlag({
      organizationId, shiftInstance, cancellationsCount: computed.cancellationsCount, varianceMinor: computed.varianceMinor,
    })
  } catch { /* scoring is advisory — never let it block a shift close */ }

  // §20 — alert Managers/Org Admins the same two moments an admin would
  // actually want to know about: a cash mismatch waiting on their approval,
  // and a shift that scored HIGH/CRITICAL risk. Best-effort: notification
  // delivery never blocks the close itself, same reasoning as anomaly scoring above.
  try {
    if (requiresApproval(computed.varianceMinor)) {
      await notificationService.notifyRoles({
        organizationId, roles: ['MANAGER', 'ORG_ADMIN'], type: 'SHIFT_TALLY_MISMATCH', severity: 'WARNING',
        title: 'Shift cash mismatch needs approval',
        body: `${staffUser.name}'s shift closed with a variance of ${computed.varianceMinor} minor units and needs sign-off.`,
        entityRef: { shiftInstanceId: shiftInstance._id },
      })
    }
    if (anomaly && ['HIGH', 'CRITICAL'].includes(anomaly.riskLevel)) {
      await notificationService.notifyRoles({
        organizationId, roles: ['MANAGER', 'ORG_ADMIN'], type: 'ANOMALY_FLAGGED', severity: anomaly.riskLevel === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
        title: `${anomaly.riskLevel} risk anomaly flagged`,
        body: `A shift closed by ${staffUser.name} scored ${anomaly.riskLevel} risk (${anomaly.riskScore}) — review required.`,
        entityRef: { anomalyId: anomaly._id, shiftInstanceId: shiftInstance._id },
      })
    }
  } catch { /* notification delivery is advisory — never let it block a shift close */ }

  return { shiftInstance, tally, requiresApproval: requiresApproval(computed.varianceMinor), anomaly }
}

/** forceCloseShift — the one state reachable without the owning staff's own action (§14). Always creates an Incident, not just an audit row — an accountability gap needs a human to close it (§H). */
async function forceCloseShift({ organizationId, actorStaffUser, shiftInstance, reason }) {
  shiftStateMachine.assertTransition(shiftInstance.status, 'ABANDONED', { isAdminOverride: true, reason })

  shiftInstance.status = 'ABANDONED'
  shiftInstance.forceClosedBy = actorStaffUser._id
  shiftInstance.forceCloseReason = reason
  shiftInstance.closedAt = new Date()
  await shiftInstance.save()

  const incident = await Incident.create({
    organizationId, type: 'SHIFT_ABANDONED', severity: 'HIGH',
    entityType: 'ShiftInstance', entityId: shiftInstance._id,
    description: `Shift force-closed by ${actorStaffUser.name}: ${reason}`,
  })

  await auditLog.recordSystem({
    organizationId, actorId: actorStaffUser._id, actorRole: actorStaffUser.role, actorName: actorStaffUser.name,
    action: 'SHIFT_FORCE_CLOSED', entityType: 'ShiftInstance', entityId: shiftInstance._id,
    newValue: { reason }, locationId: shiftInstance.locationId, shiftInstanceId: shiftInstance._id,
  })

  return { shiftInstance, incident }
}

/** approveTally — Manager+ sign-off on a mismatch past the threshold (§15). */
async function approveTally({ organizationId, staffUser, tally }) {
  if (tally.approvedBy) throw createError(409, 'This tally has already been approved', null, 'VALIDATION_ERROR')
  if (!requiresApproval(tally.varianceMinor)) {
    throw createError(409, 'This tally does not require approval', null, 'VALIDATION_ERROR')
  }
  tally.approvedBy = staffUser._id
  await tally.save()

  await auditLog.recordSystem({
    organizationId, actorId: staffUser._id, actorRole: staffUser.role, actorName: staffUser.name,
    action: 'SHIFT_TALLY_MISMATCH_APPROVED', entityType: 'ShiftTally', entityId: tally._id,
    newValue: { varianceMinor: tally.varianceMinor },
  })
  return tally
}

/**
 * initiateHandover — snapshots the LOCATION's active vehicles + token
 * inventory + cash tally at the moment of handover (§17-§18). Active
 * sessions are not touched/recreated here — they carry forward exactly by
 * continuing to exist; a session's entryShiftInstanceId stays historical
 * while its eventual exitShiftInstanceId will be whichever shift actually
 * processes the exit (§17: "do not count them as new entries").
 */
async function initiateHandover({ organizationId, actorStaffUser, fromShiftInstance, toShiftInstanceId }) {
  if (fromShiftInstance.status !== 'CLOSED') {
    throw createError(409, 'The outgoing shift must be closed (tallied) before handover can be initiated', null, 'SHIFT_INVALID_TRANSITION')
  }

  const toShiftInstance = await ShiftInstance.findOne({
    _id: toShiftInstanceId, organizationId, locationId: fromShiftInstance.locationId, status: 'OPEN',
  })
  if (!toShiftInstance) {
    throw createError(404, 'Target shift not found, not open, or not at the same location', null, 'NOT_FOUND')
  }
  if (String(toShiftInstance._id) === String(fromShiftInstance._id)) {
    throw createError(422, 'Cannot hand a shift over to itself', null, 'VALIDATION_ERROR')
  }

  const tally = await ShiftTally.findOne({ organizationId, shiftInstanceId: fromShiftInstance._id })

  const [activeCount, tokenAgg, pendingTxnCount] = await Promise.all([
    ParkingSession.countDocuments({ organizationId, locationId: fromShiftInstance.locationId, isActiveSession: true }),
    QrToken.aggregateScoped(organizationId, [
      { $match: { locationId: fromShiftInstance.locationId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    ParkingSession.countDocuments({
      organizationId, locationId: fromShiftInstance.locationId,
      status: { $in: ['CREATED', 'EXIT_REQUESTED', 'PAYMENT_PENDING'] },
    }),
  ])

  const tokenSummary = Object.fromEntries(tokenStateMachine.STATUSES.map((s) => [s, 0]))
  for (const row of tokenAgg) tokenSummary[row._id] = row.count

  const handover = await ShiftHandover.create({
    organizationId,
    locationId: fromShiftInstance.locationId,
    fromShiftInstanceId: fromShiftInstance._id,
    toShiftInstanceId: toShiftInstance._id,
    cash: tally ? { expectedCashMinor: tally.expectedCashMinor, actualCashMinor: tally.actualCashMinor, varianceMinor: tally.varianceMinor } : null,
    tokenSummary,
    activeVehicleCount: activeCount,
    pendingTxnCount,
  })

  await auditLog.recordSystem({
    organizationId, actorId: actorStaffUser._id, actorRole: actorStaffUser.role, actorName: actorStaffUser.name,
    action: 'HANDOVER_INITIATED', entityType: 'ShiftHandover', entityId: handover._id,
    newValue: { activeVehicleCount: activeCount, tokenSummary }, locationId: fromShiftInstance.locationId,
  })

  return handover
}

/** acceptHandover — only the INCOMING staff member can accept (§18: accountability doesn't transfer by someone else's say-so). */
async function acceptHandover({ organizationId, actorStaffUser, handover }) {
  if (handover.status !== 'PENDING') {
    throw createError(409, `Handover is already ${handover.status.toLowerCase()}`, null, 'VALIDATION_ERROR')
  }

  const toShiftInstance = await ShiftInstance.findOne({ _id: handover.toShiftInstanceId, organizationId })
  if (String(toShiftInstance.staffId) !== String(actorStaffUser._id)) {
    throw createError(403, 'Only the incoming staff member can accept this handover', null, 'FORBIDDEN_ROLE')
  }

  handover.status = 'ACCEPTED'
  handover.acceptedAt = new Date()
  await handover.save()

  const fromShiftInstance = await ShiftInstance.findOne({ _id: handover.fromShiftInstanceId, organizationId })
  shiftStateMachine.assertTransition(fromShiftInstance.status, 'HANDED_OVER')
  fromShiftInstance.status = 'HANDED_OVER'
  await fromShiftInstance.save()

  await auditLog.recordSystem({
    organizationId, actorId: actorStaffUser._id, actorRole: actorStaffUser.role, actorName: actorStaffUser.name,
    action: 'HANDOVER_ACCEPTED', entityType: 'ShiftHandover', entityId: handover._id,
    locationId: handover.locationId,
  })

  return { handover, fromShiftInstance }
}

module.exports = { computeTally, closeShift, forceCloseShift, approveTally, initiateHandover, acceptHandover, requiresApproval, MISMATCH_APPROVAL_THRESHOLD_MINOR }
