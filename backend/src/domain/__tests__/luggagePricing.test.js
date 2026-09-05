const { computeDurationDays, computeAmountDueMinor, GRACE_PERIOD_MIN } = require('../luggagePricing')

describe('luggagePricing.computeDurationDays', () => {
  test('within the grace period is free (0 days)', () => {
    const checkIn = new Date('2026-01-01T10:00:00Z')
    const ref = new Date(checkIn.getTime() + (GRACE_PERIOD_MIN - 1) * 60000)
    expect(computeDurationDays(checkIn, ref)).toBe(0)
  })

  test('just past the grace period bills a full day (rounds up)', () => {
    const checkIn = new Date('2026-01-01T10:00:00Z')
    const ref = new Date(checkIn.getTime() + (GRACE_PERIOD_MIN + 5) * 60000)
    expect(computeDurationDays(checkIn, ref)).toBe(1)
  })

  test('exactly 1 day + grace bills exactly 1 day, one minute more bills 2', () => {
    const checkIn = new Date('2026-01-01T10:00:00Z')
    const oneDayPlusGrace = new Date(checkIn.getTime() + GRACE_PERIOD_MIN * 60000 + 24 * 60 * 60000)
    expect(computeDurationDays(checkIn, oneDayPlusGrace)).toBe(1)
    const oneMinuteMore = new Date(oneDayPlusGrace.getTime() + 60000)
    expect(computeDurationDays(checkIn, oneMinuteMore)).toBe(2)
  })
})

describe('luggagePricing.computeAmountDueMinor', () => {
  test('multiplies billable days by the order rate', () => {
    const checkIn = new Date('2026-01-01T10:00:00Z')
    const ref = new Date(checkIn.getTime() + 3 * 24 * 60 * 60000 + GRACE_PERIOD_MIN * 60000 + 1000)
    const order = { checkInAt: checkIn, ratePerDayMinor: 5000 }
    expect(computeAmountDueMinor(order, ref)).toBe(4 * 5000)
  })

  test('an order with no pricingUnit set (every pre-existing order) is unaffected by the HOUR branch', () => {
    const checkIn = new Date('2026-01-01T10:00:00Z')
    const ref = new Date(checkIn.getTime() + 25 * 60 * 60000)
    const order = { checkInAt: checkIn, ratePerDayMinor: 5000, pricingUnit: undefined }
    expect(computeAmountDueMinor(order, ref)).toBe(2 * 5000) // 2 whole days, same as before
  })

  test('pricingUnit HOUR bills whole hours, rounded up, after the grace period', () => {
    const checkIn = new Date('2026-01-01T10:00:00Z')
    const ref = new Date(checkIn.getTime() + GRACE_PERIOD_MIN * 60000 + 3 * 60 * 60000 + 1000) // 3h 1s billable
    const order = { checkInAt: checkIn, ratePerDayMinor: 2000, pricingUnit: 'HOUR' }
    expect(computeAmountDueMinor(order, ref)).toBe(4 * 2000) // rounds up to 4 hours
  })

  test('pricingUnit HOUR with maxDays caps the total at maxDays worth of hours', () => {
    const checkIn = new Date('2026-01-01T10:00:00Z')
    const ref = new Date(checkIn.getTime() + 10 * 24 * 60 * 60000) // 10 days later
    const order = { checkInAt: checkIn, ratePerDayMinor: 2000, pricingUnit: 'HOUR', maxDays: 2 }
    expect(computeAmountDueMinor(order, ref)).toBe(2 * 24 * 2000) // capped at 2 days' worth of hours
  })

  test('pricingUnit HOUR within the grace period is free', () => {
    const checkIn = new Date('2026-01-01T10:00:00Z')
    const ref = new Date(checkIn.getTime() + (GRACE_PERIOD_MIN - 5) * 60000)
    const order = { checkInAt: checkIn, ratePerDayMinor: 2000, pricingUnit: 'HOUR' }
    expect(computeAmountDueMinor(order, ref)).toBe(0)
  })
})
