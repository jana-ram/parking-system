const { assertTransition, canTransition } = require('../tokenStateMachine')

describe('tokenStateMachine — normal lifecycle (§6)', () => {
  test('AVAILABLE -> ASSIGNED -> ACTIVE -> RETURNED -> AVAILABLE', () => {
    expect(() => assertTransition('AVAILABLE', 'ASSIGNED')).not.toThrow()
    expect(() => assertTransition('ASSIGNED', 'ACTIVE')).not.toThrow()
    expect(() => assertTransition('ACTIVE', 'RETURNED')).not.toThrow()
    // RETURNED -> AVAILABLE is a plain staff confirm, not a reinstate — no authorization needed
    expect(() => assertTransition('RETURNED', 'AVAILABLE')).not.toThrow()
  })

  test('cannot skip ASSIGNED and go straight from AVAILABLE to ACTIVE', () => {
    expect(canTransition('AVAILABLE', 'ACTIVE')).toBe(false)
  })
})

describe('tokenStateMachine — loss/damage/block, reachable from any live state', () => {
  test.each(['AVAILABLE', 'ASSIGNED', 'ACTIVE'])('%s -> LOST is allowed', (from) => {
    expect(canTransition(from, 'LOST')).toBe(true)
  })

  test('AVAILABLE -> BLOCKED is allowed but ASSIGNED/ACTIVE -> BLOCKED is not (must go through LOST/DAMAGED)', () => {
    expect(canTransition('AVAILABLE', 'BLOCKED')).toBe(true)
    expect(canTransition('ASSIGNED', 'BLOCKED')).toBe(false)
    expect(canTransition('ACTIVE', 'BLOCKED')).toBe(false)
  })
})

describe('tokenStateMachine — reinstate requires explicit admin authorization (§6)', () => {
  test.each(['LOST', 'DAMAGED', 'BLOCKED'])('%s -> AVAILABLE is rejected without authorizedReinstate', (from) => {
    expect(() => assertTransition(from, 'AVAILABLE')).toThrow(/explicit admin authorization/i)
  })

  test.each(['LOST', 'DAMAGED', 'BLOCKED'])('%s -> AVAILABLE requires a reason even when authorized', (from) => {
    expect(() => assertTransition(from, 'AVAILABLE', { authorizedReinstate: true })).toThrow(/reason is required/i)
  })

  test.each(['LOST', 'DAMAGED', 'BLOCKED'])('%s -> AVAILABLE succeeds with authorization and a reason', (from) => {
    expect(() => assertTransition(from, 'AVAILABLE', { authorizedReinstate: true, reason: 'recovered token, verified intact' })).not.toThrow()
  })

  test('plain RETURNED -> AVAILABLE does NOT require authorization (it is not a reinstate path)', () => {
    expect(() => assertTransition('RETURNED', 'AVAILABLE')).not.toThrow()
  })
})

describe('tokenStateMachine — invalid transitions', () => {
  test('LOST is terminal-ish: cannot go directly to ASSIGNED', () => {
    expect(canTransition('LOST', 'ASSIGNED')).toBe(false)
  })

  test('rejects an unrecognized "from" status', () => {
    expect(() => assertTransition('NOT_A_REAL_STATUS', 'AVAILABLE')).toThrow(/unknown token status/i)
  })
})
