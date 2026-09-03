const { assertTransition, canTransition } = require('../rackSlotStateMachine')

describe('rackSlotStateMachine — manual transitions', () => {
  test('AVAILABLE -> RESERVED/BLOCKED/MAINTENANCE all allowed with a reason', () => {
    for (const to of ['RESERVED', 'BLOCKED', 'MAINTENANCE']) {
      expect(() => assertTransition('AVAILABLE', to, { reason: 'test' })).not.toThrow()
    }
  })

  test('BLOCKED/MAINTENANCE can only go back to AVAILABLE', () => {
    expect(canTransition('BLOCKED', 'AVAILABLE')).toBe(true)
    expect(canTransition('BLOCKED', 'RESERVED')).toBe(false)
    expect(canTransition('MAINTENANCE', 'AVAILABLE')).toBe(true)
    expect(canTransition('MAINTENANCE', 'BLOCKED')).toBe(false)
  })

  test('OCCUPIED is unreachable and has no outgoing transitions via this table', () => {
    expect(canTransition('AVAILABLE', 'OCCUPIED')).toBe(false)
    expect(canTransition('OCCUPIED', 'AVAILABLE')).toBe(false)
  })

  test('a reason is required for every transition', () => {
    expect(() => assertTransition('AVAILABLE', 'BLOCKED')).toThrow(/reason/i)
  })

  test('an unknown source status throws RACK_SLOT_STATUS_INVALID', () => {
    expect(() => assertTransition('BOGUS', 'AVAILABLE', { reason: 'x' })).toThrow()
  })
})
