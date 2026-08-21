const { scoreSubject, riskLevelFor } = require('../anomalyScoring')

const CLEAN_SIGNALS = {
  cancellationsCount: 0, varianceMinor: 0, exitWithoutPaymentCount: 0,
  tokenAnomalyCount: 0, locationViolationCount: 0, backdatedTransactionCount: 0,
}

describe('anomalyScoring.scoreSubject — a clean shift', () => {
  test('produces zero score, LOW risk, and no reasons', () => {
    const result = scoreSubject(CLEAN_SIGNALS)
    expect(result.riskScore).toBe(0)
    expect(result.riskLevel).toBe('LOW')
    expect(result.reasons).toEqual([])
  })
})

describe('anomalyScoring.scoreSubject — individual rules', () => {
  test('cancellations below the threshold do not trigger', () => {
    const result = scoreSubject({ ...CLEAN_SIGNALS, cancellationsCount: 5 })
    expect(result.reasons).toEqual([])
  })

  test('cancellations above the threshold trigger, weight scales with count but is capped', () => {
    const result = scoreSubject({ ...CLEAN_SIGNALS, cancellationsCount: 20 })
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0].rule).toBe('EXCESSIVE_CANCELLATIONS')
    expect(result.reasons[0].weight).toBe(30) // capped at maxWeight
  })

  test('cash mismatch is measured in absolute value (over or under both count)', () => {
    const over = scoreSubject({ ...CLEAN_SIGNALS, varianceMinor: 85000 })
    const under = scoreSubject({ ...CLEAN_SIGNALS, varianceMinor: -85000 })
    expect(over.reasons[0].weight).toBe(under.reasons[0].weight)
    expect(over.reasons[0].detail).toContain('₹850.00')
  })

  test('exit-without-payment is weighted heavily even for a single occurrence', () => {
    const result = scoreSubject({ ...CLEAN_SIGNALS, exitWithoutPaymentCount: 1 })
    expect(result.reasons[0].rule).toBe('EXIT_WITHOUT_PAYMENT')
    expect(result.reasons[0].weight).toBe(20)
  })
})

describe('anomalyScoring.scoreSubject — the §20 worked-example shape (explainable, multi-reason, HIGH risk)', () => {
  test('several simultaneous signals combine into a HIGH/CRITICAL score with a full reasons list', () => {
    const result = scoreSubject({
      cancellationsCount: 18,
      varianceMinor: -85000,
      exitWithoutPaymentCount: 2,
      tokenAnomalyCount: 4,
      locationViolationCount: 3,
      backdatedTransactionCount: 0,
    })
    expect(result.reasons.length).toBeGreaterThanOrEqual(4)
    expect(['HIGH', 'CRITICAL']).toContain(result.riskLevel)
    // every reason is traceable — a Manager reading this can see exactly why
    for (const reason of result.reasons) {
      expect(reason.rule).toBeTruthy()
      expect(reason.detail).toBeTruthy()
      expect(reason.weight).toBeGreaterThan(0)
    }
  })
})

describe('anomalyScoring.riskLevelFor', () => {
  test.each([
    [0, 'LOW'], [19, 'LOW'], [20, 'MEDIUM'], [44, 'MEDIUM'],
    [45, 'HIGH'], [69, 'HIGH'], [70, 'CRITICAL'], [100, 'CRITICAL'],
  ])('score %i -> %s', (score, expected) => {
    expect(riskLevelFor(score)).toBe(expected)
  })
})
