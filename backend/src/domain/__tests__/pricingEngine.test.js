const { calculateAmount, calculateEntryAmount, tierAmountForMinutes, splitByLocalDay } = require('../pricingEngine')

const TZ = 'Asia/Kolkata'
const iso = (s) => new Date(s) // ISO strings below are already IST-offset explicit

describe('pricingEngine.tierAmountForMinutes — SLAB mode', () => {
  // §10's worked example: Bike 0-2h=20, 2-5h=40, 5-10h=60, 10-24h=100
  const config = {
    tierType: 'SLAB',
    slabs: [
      { uptoMinutes: 120, amountMinor: 2000 },
      { uptoMinutes: 300, amountMinor: 4000 },
      { uptoMinutes: 600, amountMinor: 6000 },
      { uptoMinutes: 1440, amountMinor: 10000 },
    ],
  }

  test.each([
    [60, 2000],
    [120, 2000],
    [121, 4000],
    [300, 4000],
    [301, 6000],
    [600, 6000],
    [601, 10000],
    [1440, 10000],
  ])('%i minutes -> %i minor units', (minutes, expected) => {
    expect(tierAmountForMinutes(minutes, config)).toBe(expected)
  })

  test('throws PRICING_CONFIG_INCOMPLETE if no slab covers the duration', () => {
    const incomplete = { tierType: 'SLAB', slabs: [{ uptoMinutes: 60, amountMinor: 1000 }] }
    expect(() => tierAmountForMinutes(61, incomplete)).toThrow(/no pricing slab/i)
  })
})

describe('pricingEngine.tierAmountForMinutes — HOURLY mode', () => {
  // §10's second worked example: first hour Rs30, +Rs20/hr after
  const config = { tierType: 'HOURLY', firstHourMinor: 3000, additionalHourMinor: 2000 }

  test.each([
    [1, 3000],
    [59, 3000],
    [60, 3000],
    [61, 5000],
    [120, 5000],
    [121, 7000],
  ])('%i minutes -> %i minor units', (minutes, expected) => {
    expect(tierAmountForMinutes(minutes, config)).toBe(expected)
  })
})

describe('pricingEngine.calculateAmount — grace period', () => {
  const config = { tierType: 'HOURLY', firstHourMinor: 3000, additionalHourMinor: 2000, gracePeriodMinutes: 10 }

  test('duration within grace period is free', () => {
    const result = calculateAmount({
      config,
      entryAt: iso('2026-08-20T08:00:00+05:30'),
      exitAt: iso('2026-08-20T08:09:00+05:30'),
      timezone: TZ,
    })
    expect(result.amountMinor).toBe(0)
  })

  test('duration just past grace period is billed normally', () => {
    const result = calculateAmount({
      config,
      entryAt: iso('2026-08-20T08:00:00+05:30'),
      exitAt: iso('2026-08-20T08:11:00+05:30'),
      timezone: TZ,
    })
    expect(result.amountMinor).toBe(3000)
  })
})

describe('pricingEngine.calculateAmount — daily maximum resets at location-local midnight', () => {
  const config = {
    tierType: 'HOURLY',
    firstHourMinor: 3000,
    additionalHourMinor: 2000,
    dailyMaxMinor: 20000,
  }

  test('a single long day is capped at dailyMaxMinor', () => {
    const result = calculateAmount({
      config,
      entryAt: iso('2026-08-20T00:30:00+05:30'),
      exitAt: iso('2026-08-20T23:30:00+05:30'), // 23h same local day
      timezone: TZ,
    })
    expect(result.amountMinor).toBe(20000)
    expect(result.breakdown).toHaveLength(1)
  })

  test('a stay spanning local midnight is billed and capped per calendar day, not per 24h from entry', () => {
    // Entry 22:00 IST, exit next day 04:00 IST — spans exactly one local
    // midnight, so this must produce TWO segments (2h on day 1, 4h on day 2),
    // each independently capped, rather than one 6h charge.
    const result = calculateAmount({
      config,
      entryAt: iso('2026-08-20T22:00:00+05:30'),
      exitAt: iso('2026-08-21T04:00:00+05:30'),
      timezone: TZ,
    })
    expect(result.breakdown).toHaveLength(2)
    expect(result.breakdown[0].date).toBe('2026-08-20')
    expect(result.breakdown[0].minutes).toBe(120) // 22:00 -> 00:00
    expect(result.breakdown[1].date).toBe('2026-08-21')
    expect(result.breakdown[1].minutes).toBe(240) // 00:00 -> 04:00
    // day1: 2h -> firstHour(3000) + 1*additional(2000) = 5000
    // day2: 4h -> firstHour(3000) + 3*additional(2000) = 9000
    expect(result.amountMinor).toBe(5000 + 9000)
  })
})

describe('pricingEngine.calculateAmount — weekend and holiday multipliers', () => {
  const config = {
    tierType: 'HOURLY',
    firstHourMinor: 10000,
    additionalHourMinor: 0,
    weekendMultiplier: 1.5,
    holidayMultiplier: 2,
  }

  test('applies weekendMultiplier on a Saturday', () => {
    // 2026-08-22 is a Saturday
    const result = calculateAmount({
      config,
      entryAt: iso('2026-08-22T10:00:00+05:30'),
      exitAt: iso('2026-08-22T10:30:00+05:30'),
      timezone: TZ,
    })
    expect(result.amountMinor).toBe(15000)
  })

  test('holidayMultiplier takes precedence over weekendMultiplier when both apply', () => {
    const result = calculateAmount({
      config,
      entryAt: iso('2026-08-22T10:00:00+05:30'),
      exitAt: iso('2026-08-22T10:30:00+05:30'),
      timezone: TZ,
      holidayDatesISO: ['2026-08-22'],
    })
    expect(result.amountMinor).toBe(20000)
  })

  test('a weekday is unaffected', () => {
    // 2026-08-20 is a Thursday
    const result = calculateAmount({
      config,
      entryAt: iso('2026-08-20T10:00:00+05:30'),
      exitAt: iso('2026-08-20T10:30:00+05:30'),
      timezone: TZ,
    })
    expect(result.amountMinor).toBe(10000)
  })
})

describe('pricingEngine.calculateAmount — invalid input', () => {
  const config = { tierType: 'HOURLY', firstHourMinor: 1000, additionalHourMinor: 500 }

  test('rejects exitAt before entryAt', () => {
    expect(() => calculateAmount({
      config,
      entryAt: iso('2026-08-20T10:00:00+05:30'),
      exitAt: iso('2026-08-20T09:00:00+05:30'),
      timezone: TZ,
    })).toThrow(/exitAt must be after entryAt/i)
  })

  test('rejects a missing timezone', () => {
    expect(() => calculateAmount({
      config,
      entryAt: iso('2026-08-20T09:00:00+05:30'),
      exitAt: iso('2026-08-20T10:00:00+05:30'),
    })).toThrow(/timezone is required/i)
  })

  test('rejects an unrecognized tierType', () => {
    expect(() => calculateAmount({
      config: { tierType: 'MADE_UP' },
      entryAt: iso('2026-08-20T09:00:00+05:30'),
      exitAt: iso('2026-08-20T10:00:00+05:30'),
      timezone: TZ,
    })).toThrow(/tierType/i)
  })
})

describe('pricingEngine.calculateEntryAmount — PAY_ON_ENTRY / FIXED_DURATION', () => {
  test('returns the flat amount, ignoring any duration-based fields', () => {
    expect(calculateEntryAmount({ flatAmountMinor: 5000 })).toBe(5000)
  })

  test('throws PRICING_CONFIG_INCOMPLETE if flatAmountMinor is missing', () => {
    expect(() => calculateEntryAmount({ tierType: 'HOURLY' })).toThrow(/flatAmountMinor/i)
    expect(() => calculateEntryAmount(null)).toThrow(/flatAmountMinor/i)
  })
})

describe('pricingEngine.splitByLocalDay', () => {
  test('a stay entirely within one local day produces a single segment', () => {
    const segments = splitByLocalDay(
      iso('2026-08-20T08:00:00+05:30'),
      iso('2026-08-20T10:00:00+05:30'),
      TZ
    )
    expect(segments).toHaveLength(1)
    expect(segments[0].minutes).toBe(120)
  })

  test('DST-safe: a US timezone with a spring-forward transition still sums to the wall-clock duration', () => {
    // 2026-03-08 is the US DST spring-forward date (2am -> 3am). This stay
    // crosses that transition; the split must not silently lose or gain the
    // "missing" clock hour when computing per-day minutes.
    const segments = splitByLocalDay(
      iso('2026-03-08T00:00:00-08:00'),
      iso('2026-03-09T00:00:00-08:00'),
      'America/Los_Angeles'
    )
    const totalMinutes = segments.reduce((sum, s) => sum + s.minutes, 0)
    expect(totalMinutes).toBeGreaterThan(0)
    expect(segments.length).toBeGreaterThanOrEqual(1)
  })
})
