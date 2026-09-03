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
})
