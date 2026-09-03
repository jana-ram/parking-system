/**
 * luggagePricing.js — pure duration/amount calc for LuggageOrder (§10/§11).
 * Flat per-day rate with a grace period: free within the grace window, then
 * billed in whole days rounded up (matches parking's daily-max convention of
 * never partially billing a day the customer only just started).
 */
const GRACE_PERIOD_MIN = 30

function computeDurationDays(checkInAt, referenceAt = new Date()) {
  const ms = new Date(referenceAt).getTime() - new Date(checkInAt).getTime()
  const minutes = Math.max(0, ms / 60000)
  if (minutes <= GRACE_PERIOD_MIN) return 0
  const billableMinutes = minutes - GRACE_PERIOD_MIN
  return Math.max(1, Math.ceil(billableMinutes / (24 * 60)))
}

function computeAmountDueMinor(order, referenceAt = new Date()) {
  const days = computeDurationDays(order.checkInAt, referenceAt)
  return days * order.ratePerDayMinor
}

module.exports = { GRACE_PERIOD_MIN, computeDurationDays, computeAmountDueMinor }
