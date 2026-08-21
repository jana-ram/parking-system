const { assertTransition, canTransition } = require('../shiftStateMachine')

describe('shiftStateMachine — normal lifecycle (§H)', () => {
  test('OPEN -> TALLY_PENDING -> CLOSED -> HANDED_OVER', () => {
    expect(() => assertTransition('OPEN', 'TALLY_PENDING')).not.toThrow()
    expect(() => assertTransition('TALLY_PENDING', 'CLOSED')).not.toThrow()
    expect(() => assertTransition('CLOSED', 'HANDED_OVER')).not.toThrow()
  })

  test('cannot skip TALLY_PENDING and close directly from OPEN', () => {
    expect(canTransition('OPEN', 'CLOSED')).toBe(false)
  })
})

describe('shiftStateMachine — ABANDONED requires an explicit admin override (§14)', () => {
  test.each(['OPEN', 'TALLY_PENDING'])('%s -> ABANDONED is rejected without isAdminOverride', (from) => {
    expect(() => assertTransition(from, 'ABANDONED')).toThrow(/admin override/i)
  })

  test('ABANDONED requires a reason even when authorized', () => {
    expect(() => assertTransition('OPEN', 'ABANDONED', { isAdminOverride: true })).toThrow(/reason is required/i)
  })

  test('ABANDONED succeeds with override + reason', () => {
    expect(() => assertTransition('OPEN', 'ABANDONED', { isAdminOverride: true, reason: 'device lost, staff unreachable' })).not.toThrow()
  })

  test('CLOSED cannot be abandoned — it already closed cleanly', () => {
    expect(canTransition('CLOSED', 'ABANDONED')).toBe(false)
  })
})

describe('shiftStateMachine — terminal states', () => {
  test.each(['HANDED_OVER', 'ABANDONED'])('%s rejects every further transition', (terminal) => {
    expect(() => assertTransition(terminal, 'OPEN')).toThrow(/already/i)
  })
})
