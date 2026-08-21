const ParkingSession = require('../models/ParkingSession')
const TokenMovement = require('../models/TokenMovement')
const AuditLog = require('../models/AuditLog')
const Anomaly = require('../models/Anomaly')
const { scoreSubject } = require('../domain/anomalyScoring')

const MIN_SCORE_TO_FLAG = 10 // below this, nothing worth a Manager's attention — no Anomaly row created at all

const TOKEN_CYCLE_ANOMALY_MS = 2 * 60 * 1000 // §R: "<2 min cycle"
const BACKDATED_THRESHOLD_MS = 15 * 60 * 1000 // §44 test case #22's timezone/backdating scenario

async function countExitWithoutPayment({ organizationId, shiftInstanceId }) {
  return ParkingSession.countDocuments({
    organizationId,
    exitShiftInstanceId: shiftInstanceId,
    status: 'COMPLETED',
    $expr: { $lt: ['$amountPaidMinor', '$amountDueMinor'] },
  })
}

/** §R: same token ASSIGNED->RETURNED faster than a plausible real parking stay, repeated. */
async function countTokenAnomalies({ organizationId, shiftInstanceId }) {
  const movements = await TokenMovement.find({
    organizationId, shiftInstanceId, toStatus: { $in: ['ASSIGNED', 'RETURNED'] }, sessionId: { $ne: null },
  }).select('sessionId toStatus createdAt').sort({ createdAt: 1 })

  const bySession = new Map()
  for (const m of movements) {
    const key = String(m.sessionId)
    if (!bySession.has(key)) bySession.set(key, {})
    bySession.get(key)[m.toStatus] = m.createdAt
  }

  let count = 0
  for (const times of bySession.values()) {
    if (times.ASSIGNED && times.RETURNED && times.RETURNED.getTime() - times.ASSIGNED.getTime() < TOKEN_CYCLE_ANOMALY_MS) {
      count += 1
    }
  }
  return count
}

async function countLocationViolations({ organizationId, shiftInstanceId }) {
  return AuditLog.countDocuments({ organizationId, shiftInstanceId, action: 'LOCATION_VERIFICATION_FAILED' })
}

/** §44 test case #22: entry/exit timestamps notably earlier than when the record was actually written. */
async function countBackdatedTransactions({ organizationId, shiftInstanceId }) {
  const sessions = await ParkingSession.find({
    organizationId,
    $or: [{ entryShiftInstanceId: shiftInstanceId }, { exitShiftInstanceId: shiftInstanceId }],
  }).select('entryAt exitAt createdAt updatedAt entryShiftInstanceId exitShiftInstanceId')

  let count = 0
  for (const s of sessions) {
    if (String(s.entryShiftInstanceId) === String(shiftInstanceId) && s.createdAt.getTime() - s.entryAt.getTime() > BACKDATED_THRESHOLD_MS) count += 1
    if (s.exitAt && String(s.exitShiftInstanceId) === String(shiftInstanceId) && s.updatedAt.getTime() - s.exitAt.getTime() > BACKDATED_THRESHOLD_MS) count += 1
  }
  return count
}

/**
 * scoreShiftAndFlag — called automatically at shift close (services/shift.service.js),
 * the same "compute a risk signal right where the data naturally completes"
 * pattern the architecture doc's §R calls for (mirroring how
 * riderAutoChecks.service.js is invoked from the ride-booking flow in the
 * sibling product). Returns null when nothing crossed MIN_SCORE_TO_FLAG —
 * most shifts, most days, should produce no Anomaly row at all.
 */
async function scoreShiftAndFlag({ organizationId, shiftInstance, cancellationsCount, varianceMinor }) {
  const [exitWithoutPaymentCount, tokenAnomalyCount, locationViolationCount, backdatedTransactionCount] = await Promise.all([
    countExitWithoutPayment({ organizationId, shiftInstanceId: shiftInstance._id }),
    countTokenAnomalies({ organizationId, shiftInstanceId: shiftInstance._id }),
    countLocationViolations({ organizationId, shiftInstanceId: shiftInstance._id }),
    countBackdatedTransactions({ organizationId, shiftInstanceId: shiftInstance._id }),
  ])

  const { riskScore, riskLevel, reasons } = scoreSubject({
    cancellationsCount, varianceMinor, exitWithoutPaymentCount, tokenAnomalyCount, locationViolationCount, backdatedTransactionCount,
  })

  if (riskScore < MIN_SCORE_TO_FLAG) return null

  return Anomaly.create({
    organizationId,
    subjectType: 'SHIFT',
    subjectId: shiftInstance._id,
    riskScore,
    riskLevel,
    reasons,
  })
}

module.exports = { scoreShiftAndFlag, countExitWithoutPayment, countTokenAnomalies, countLocationViolations, countBackdatedTransactions, MIN_SCORE_TO_FLAG }
