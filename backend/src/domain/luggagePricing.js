/**
 * luggagePricing.js — pure duration/amount calc for LuggageOrder/ParcelOrder
 * (§8/§9, and §2's "support hourly/daily/multiple-day pricing"). Grace
 * period is free, then billed in whole units rounded up (matches parking's
 * daily-max convention of never partially billing a unit the customer only
 * just started) — either whole DAYS (the original, still-default behavior)
 * or whole HOURS when the order's pricingUnit says so, optionally capped at
 * maxDays worth so an hourly rate never runs away on a long stay.
 */
const GRACE_PERIOD_MIN = 30

function computeBillableMinutes(checkInAt, referenceAt = new Date()) {
  const ms = new Date(referenceAt).getTime() - new Date(checkInAt).getTime()
  const minutes = Math.max(0, ms / 60000)
  return minutes <= GRACE_PERIOD_MIN ? 0 : minutes - GRACE_PERIOD_MIN
}

function computeDurationDays(checkInAt, referenceAt = new Date()) {
  const billableMinutes = computeBillableMinutes(checkInAt, referenceAt)
  if (billableMinutes === 0) return 0
  return Math.max(1, Math.ceil(billableMinutes / (24 * 60)))
}

function computeDurationHours(checkInAt, referenceAt = new Date()) {
  const billableMinutes = computeBillableMinutes(checkInAt, referenceAt)
  if (billableMinutes === 0) return 0
  return Math.max(1, Math.ceil(billableMinutes / 60))
}

// order.pricingUnit is only ever 'HOUR' for orders checked in against an
// hourly ItemPricingRule (see luggage.service.js/parcel.service.js) —
// everything else (including every order that existed before this field
// did) falls through to the original flat-per-day behavior unchanged.
function computeAmountDueMinor(order, referenceAt = new Date()) {
  if (order.pricingUnit === 'HOUR') {
    const hours = computeDurationHours(order.checkInAt, referenceAt)
    const amountMinor = hours * order.ratePerDayMinor
    if (!order.maxDays) return amountMinor
    const capMinor = order.maxDays * 24 * order.ratePerDayMinor
    return Math.min(amountMinor, capMinor)
  }
  const days = computeDurationDays(order.checkInAt, referenceAt)
  return days * order.ratePerDayMinor
}

module.exports = { GRACE_PERIOD_MIN, computeDurationDays, computeDurationHours, computeAmountDueMinor }
