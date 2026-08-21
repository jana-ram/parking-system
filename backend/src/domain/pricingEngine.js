/**
 * pricingEngine.js — pure functions, no I/O, no Mongoose. Given a frozen
 * PricingRuleVersion.config (see that model's header comment for the shape)
 * and an entry/exit window, computes the amount due in minor currency units.
 * This is the ONLY function allowed to produce amountDueMinor — the server
 * never trusts a client-supplied amount (§X), and every ParkingSession pins
 * the pricingRuleVersionId it was computed with so historical bills stay
 * reproducible even after the pricing policy later changes (§10).
 *
 * Daily maximum resets at LOCATION-LOCAL MIDNIGHT (§1 item 10), not UTC and
 * not "24h from entry" — the reason every calculation below is timezone-aware.
 * That's also why this file's one new dependency is `luxon`: Node has no
 * built-in reliable way to ask "what calendar day is this instant in IANA
 * zone X, and where's the next local midnight" without either hand-rolling
 * DST-unsafe offset math or pulling in a timezone library. luxon is small,
 * has no further transitive dependencies of its own, and is the de facto
 * standard for this exact problem — justified per the "explain any new
 * dependency" working rule rather than added silently.
 */
const { DateTime } = require('luxon')
const { createError } = require('../utils/helpers')

const TIER_TYPES = ['SLAB', 'HOURLY']

/**
 * Splits [entryAt, exitAt) into segments at each location-local midnight, so a
 * multi-day stay is billed one calendar day at a time — the same boundary a
 * human reading "daily maximum" would expect, and the one §1 item 10 commits to.
 */
function splitByLocalDay(entryAt, exitAt, timezone) {
  const start = DateTime.fromJSDate(entryAt, { zone: timezone })
  const end = DateTime.fromJSDate(exitAt, { zone: timezone })
  if (!start.isValid || !end.isValid) {
    throw createError(422, `Invalid entryAt/exitAt for timezone "${timezone}"`, null, 'INVALID_PRICING_INPUT')
  }
  if (end <= start) {
    throw createError(422, 'exitAt must be after entryAt', null, 'INVALID_PRICING_INPUT')
  }

  const segments = []
  let cursor = start
  while (cursor < end) {
    const nextMidnight = cursor.plus({ days: 1 }).startOf('day')
    const segmentEnd = nextMidnight < end ? nextMidnight : end
    segments.push({
      date: cursor.toISODate(),
      weekday: cursor.weekday % 7, // luxon: Mon=1..Sun=7 -> normalize to Sun=0..Sat=6
      minutes: segmentEnd.diff(cursor, 'minutes').minutes,
    })
    cursor = segmentEnd
  }
  return segments
}

function tierAmountForMinutes(minutes, config) {
  if (config.tierType === 'SLAB') {
    const slabs = [...(config.slabs || [])].sort((a, b) => {
      if (a.uptoMinutes == null) return 1
      if (b.uptoMinutes == null) return -1
      return a.uptoMinutes - b.uptoMinutes
    })
    const hit = slabs.find(s => s.uptoMinutes == null || minutes <= s.uptoMinutes)
    if (!hit) {
      throw createError(
        422,
        'No pricing slab matches this duration — config.slabs must cover all durations (add an open-ended final slab)',
        null,
        'PRICING_CONFIG_INCOMPLETE'
      )
    }
    return hit.amountMinor
  }
  if (config.tierType === 'HOURLY') {
    const hours = Math.max(1, Math.ceil(minutes / 60))
    const extraHours = Math.max(0, hours - 1)
    return (config.firstHourMinor || 0) + extraHours * (config.additionalHourMinor || 0)
  }
  throw createError(422, `Unknown pricing tierType "${config.tierType}" — expected one of ${TIER_TYPES.join(', ')}`, null, 'PRICING_CONFIG_INVALID')
}

/**
 * @param {object} params
 * @param {object} params.config - PricingRuleVersion.config
 * @param {Date} params.entryAt
 * @param {Date} params.exitAt
 * @param {string} params.timezone - IANA zone name, from Location.timezone
 * @param {string[]} [params.holidayDatesISO] - 'YYYY-MM-DD' dates in `timezone`, from the Holiday collection
 * @returns {{ amountMinor: number, durationMinutes: number, breakdown: object[] }}
 */
function calculateAmount({ config, entryAt, exitAt, timezone, holidayDatesISO = [] }) {
  if (!config || !TIER_TYPES.includes(config.tierType)) {
    throw createError(422, 'Pricing config missing or has an unrecognized tierType', null, 'PRICING_CONFIG_INVALID')
  }
  if (!timezone) {
    throw createError(422, 'timezone is required to calculate pricing (daily maximum resets at location-local midnight)', null, 'INVALID_PRICING_INPUT')
  }

  const totalMinutes = (exitAt.getTime() - entryAt.getTime()) / 60000
  if (totalMinutes <= 0) {
    throw createError(422, 'exitAt must be after entryAt', null, 'INVALID_PRICING_INPUT')
  }

  const gracePeriodMinutes = config.gracePeriodMinutes || 0
  if (totalMinutes <= gracePeriodMinutes) {
    return { amountMinor: 0, durationMinutes: totalMinutes, breakdown: [{ note: 'within grace period', minutes: totalMinutes }] }
  }

  const segments = splitByLocalDay(entryAt, exitAt, timezone)
  const dailyMaxMinor = config.dailyMaxMinor

  let amountMinor = 0
  const breakdown = segments.map((seg) => {
    let amount = tierAmountForMinutes(seg.minutes, config)

    const isWeekendDay = seg.weekday === 0 || seg.weekday === 6
    const isHolidayDay = holidayDatesISO.includes(seg.date)
    let multiplier = 1
    if (isHolidayDay && config.holidayMultiplier) multiplier = config.holidayMultiplier
    else if (isWeekendDay && config.weekendMultiplier) multiplier = config.weekendMultiplier
    amount = Math.round(amount * multiplier)

    if (dailyMaxMinor != null) amount = Math.min(amount, dailyMaxMinor)

    amountMinor += amount
    return { date: seg.date, minutes: seg.minutes, isWeekendDay, isHolidayDay, multiplier, amountMinor: amount }
  })

  return { amountMinor, durationMinutes: totalMinutes, breakdown }
}

/**
 * calculateEntryAmount — for PAY_ON_ENTRY / FIXED_DURATION modes, where the
 * amount must be known and captured AT ENTRY, before exitAt exists at all.
 * calculateAmount() above is fundamentally duration-based and cannot run yet
 * at that point — this is a deliberate second entry point, not an oversight.
 *
 * [Phase 3 design decision, not spelled out explicitly in the original brief's
 * §10] config.flatAmountMinor is the amount charged at entry. FIXED_DURATION's
 * "what if the vehicle overstays the paid-for window" case is real but its own
 * sub-flow (an extra charge collected at exit, structurally similar to a
 * correction) — deferred past Phase 3 rather than guessed at here; a session
 * using this mode is billed the flat amount and nothing more for now.
 */
function calculateEntryAmount(config) {
  if (config == null || config.flatAmountMinor == null) {
    throw createError(422, 'PAY_ON_ENTRY/FIXED_DURATION pricing requires config.flatAmountMinor', null, 'PRICING_CONFIG_INCOMPLETE')
  }
  return config.flatAmountMinor
}

module.exports = { TIER_TYPES, calculateAmount, calculateEntryAmount, splitByLocalDay, tierAmountForMinutes }
