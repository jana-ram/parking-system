const { nextAttempt, isRetryStorm, BACKOFF_SCHEDULE_MS, MAX_RETRIES } = require('../retryPolicy')

describe('retryPolicy.nextAttempt — the §25 bounded backoff schedule', () => {
  test('follows 5s, 15s, 30s, 1min, 5min in order', () => {
    const now = new Date('2026-08-20T00:00:00Z')
    expect(nextAttempt(0, now)).toEqual({ status: 'FAILED', nextAttemptAt: new Date('2026-08-20T00:00:05Z') })
    expect(nextAttempt(1, now)).toEqual({ status: 'FAILED', nextAttemptAt: new Date('2026-08-20T00:00:15Z') })
    expect(nextAttempt(2, now)).toEqual({ status: 'FAILED', nextAttemptAt: new Date('2026-08-20T00:00:30Z') })
    expect(nextAttempt(3, now)).toEqual({ status: 'FAILED', nextAttemptAt: new Date('2026-08-20T00:01:00Z') })
    expect(nextAttempt(4, now)).toEqual({ status: 'FAILED', nextAttemptAt: new Date('2026-08-20T00:05:00Z') })
  })

  test('gives up (BLOCKED, no more scheduled attempts) once the schedule is exhausted — never retries forever', () => {
    expect(nextAttempt(MAX_RETRIES)).toEqual({ status: 'BLOCKED', nextAttemptAt: null })
    expect(nextAttempt(MAX_RETRIES + 10)).toEqual({ status: 'BLOCKED', nextAttemptAt: null })
  })

  test('the schedule itself is exactly the 5 documented steps', () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([5000, 15000, 30000, 60000, 300000])
    expect(MAX_RETRIES).toBe(5)
  })
})

describe('retryPolicy.isRetryStorm', () => {
  test('flags an abnormal burst of attempts within the window', () => {
    const now = Date.now()
    const attempts = Array.from({ length: 12 }, (_, i) => new Date(now - i * 1000)) // 12 attempts in the last 12s
    expect(isRetryStorm(attempts)).toBe(true)
  })

  test('does not flag a normal, sparse retry pattern', () => {
    const now = Date.now()
    const attempts = [new Date(now - 5000), new Date(now - 20000)]
    expect(isRetryStorm(attempts)).toBe(false)
  })

  test('ignores attempts outside the window', () => {
    const now = Date.now()
    const oldAttempts = Array.from({ length: 20 }, (_, i) => new Date(now - (i + 5) * 60_000)) // all >4min ago
    expect(isRetryStorm(oldAttempts, { windowMs: 60_000 })).toBe(false)
  })
})
