/**
 * anomalyScoring.js — pure function implementing §20's explainable risk
 * scoring: given a bag of already-counted signals for one subject (a shift,
 * in this phase), produce a risk score/level and a reasons list a Manager
 * can actually read and act on — never a bare number (§20: "risk scoring
 * should be explainable").
 *
 * [Phase 6 scope note] §R's full rule list includes several signals this
 * product doesn't have the underlying feature for yet — excessive discounts,
 * manual fee changes, and repeated corrections all need a discount/correction
 * feature that hasn't been built (Phase 4's shift tally already documented
 * discountsMinor/correctionsCount as placeholder zeros for the same reason).
 * "Device sharing" is deliberately NOT a rule here at all — this product's
 * own architecture (§1.7/Phase 2) treats one device being used across
 * multiple staff members' shifts as the EXPECTED, legitimate pattern (a
 * device belongs to a location, not to one individual), so flagging it would
 * misfire on every ordinary shift handover. The rules below are the ones
 * with real data behind them today.
 */
const RULES = {
  EXCESSIVE_CANCELLATIONS: { threshold: 5, weightPerUnit: 4, maxWeight: 30 },
  CASH_MISMATCH: { thresholdMinor: 10_000, weightPerThousand: 3, maxWeight: 30 }, // same ₹100 threshold as shift approval, §15
  EXIT_WITHOUT_PAYMENT: { weightEach: 20, maxWeight: 40 }, // serious on its own — §12 "never allow exit as PAID unless..."
  TOKEN_REUSE_ANOMALY: { threshold: 3, weightEach: 8, maxWeight: 24 }, // §R: rapid assign/return cycles
  LOCATION_VIOLATIONS: { threshold: 3, weightEach: 5, maxWeight: 20 },
  BACKDATED_TRANSACTIONS: { threshold: 1, weightEach: 6, maxWeight: 24 },
}

const RISK_BANDS = [
  { level: 'CRITICAL', min: 70 },
  { level: 'HIGH', min: 45 },
  { level: 'MEDIUM', min: 20 },
  { level: 'LOW', min: 0 },
]

function riskLevelFor(score) {
  return RISK_BANDS.find((b) => score >= b.min).level
}

/**
 * @param {object} signals
 * @param {number} signals.cancellationsCount
 * @param {number} signals.varianceMinor - absolute cash variance from the shift tally
 * @param {number} signals.exitWithoutPaymentCount
 * @param {number} signals.tokenAnomalyCount
 * @param {number} signals.locationViolationCount
 * @param {number} signals.backdatedTransactionCount
 * @returns {{ riskScore: number, riskLevel: string, reasons: {rule: string, weight: number, detail: string}[] }}
 */
function scoreSubject(signals) {
  const reasons = []

  if (signals.cancellationsCount > RULES.EXCESSIVE_CANCELLATIONS.threshold) {
    const weight = Math.min(signals.cancellationsCount * RULES.EXCESSIVE_CANCELLATIONS.weightPerUnit, RULES.EXCESSIVE_CANCELLATIONS.maxWeight)
    reasons.push({ rule: 'EXCESSIVE_CANCELLATIONS', weight, detail: `${signals.cancellationsCount} cancellations` })
  }

  const absVariance = Math.abs(signals.varianceMinor || 0)
  if (absVariance > RULES.CASH_MISMATCH.thresholdMinor) {
    const weight = Math.min(Math.floor(absVariance / 1000) * RULES.CASH_MISMATCH.weightPerThousand, RULES.CASH_MISMATCH.maxWeight)
    reasons.push({ rule: 'CASH_MISMATCH', weight, detail: `₹${(absVariance / 100).toFixed(2)} cash mismatch` })
  }

  if (signals.exitWithoutPaymentCount > 0) {
    const weight = Math.min(signals.exitWithoutPaymentCount * RULES.EXIT_WITHOUT_PAYMENT.weightEach, RULES.EXIT_WITHOUT_PAYMENT.maxWeight)
    reasons.push({ rule: 'EXIT_WITHOUT_PAYMENT', weight, detail: `${signals.exitWithoutPaymentCount} exit(s) completed without full payment` })
  }

  if (signals.tokenAnomalyCount >= RULES.TOKEN_REUSE_ANOMALY.threshold) {
    const weight = Math.min(signals.tokenAnomalyCount * RULES.TOKEN_REUSE_ANOMALY.weightEach, RULES.TOKEN_REUSE_ANOMALY.maxWeight)
    reasons.push({ rule: 'TOKEN_REUSE_ANOMALY', weight, detail: `${signals.tokenAnomalyCount} abnormally fast token reuse cycles` })
  }

  if (signals.locationViolationCount >= RULES.LOCATION_VIOLATIONS.threshold) {
    const weight = Math.min(signals.locationViolationCount * RULES.LOCATION_VIOLATIONS.weightEach, RULES.LOCATION_VIOLATIONS.maxWeight)
    reasons.push({ rule: 'LOCATION_VIOLATIONS', weight, detail: `${signals.locationViolationCount} location verification failures` })
  }

  if (signals.backdatedTransactionCount >= RULES.BACKDATED_TRANSACTIONS.threshold) {
    const weight = Math.min(signals.backdatedTransactionCount * RULES.BACKDATED_TRANSACTIONS.weightEach, RULES.BACKDATED_TRANSACTIONS.maxWeight)
    reasons.push({ rule: 'BACKDATED_TRANSACTIONS', weight, detail: `${signals.backdatedTransactionCount} backdated transaction(s)` })
  }

  const riskScore = Math.min(reasons.reduce((sum, r) => sum + r.weight, 0), 100)
  return { riskScore, riskLevel: riskLevelFor(riskScore), reasons }
}

module.exports = { scoreSubject, riskLevelFor, RULES, RISK_BANDS }
