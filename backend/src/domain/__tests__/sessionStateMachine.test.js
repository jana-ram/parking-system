const { assertTransition, canTransition } = require('../sessionStateMachine')

describe('sessionStateMachine — PAY_ON_EXIT (default mode, §1 item 3)', () => {
  test('walks the full happy path', () => {
    expect(() => assertTransition('PAY_ON_EXIT', 'CREATED', 'ACTIVE')).not.toThrow()
    expect(() => assertTransition('PAY_ON_EXIT', 'ACTIVE', 'EXIT_REQUESTED')).not.toThrow()
    expect(() => assertTransition('PAY_ON_EXIT', 'EXIT_REQUESTED', 'PAYMENT_PENDING')).not.toThrow()
    expect(() => assertTransition('PAY_ON_EXIT', 'PAYMENT_PENDING', 'PAID')).not.toThrow()
    expect(() => assertTransition('PAY_ON_EXIT', 'PAID', 'COMPLETED')).not.toThrow()
  })

  test('cannot jump straight from ACTIVE to PAID — amount is only known after EXIT_REQUESTED', () => {
    expect(canTransition('PAY_ON_EXIT', 'ACTIVE', 'PAID')).toBe(false)
    expect(() => assertTransition('PAY_ON_EXIT', 'ACTIVE', 'PAID')).toThrow(/cannot transition/i)
  })

  test('CREATED and ACTIVE can be cancelled by a Manager with a reason', () => {
    expect(() => assertTransition('PAY_ON_EXIT', 'CREATED', 'CANCELLED', { reason: 'mis-entry', actorRole: 'MANAGER' })).not.toThrow()
    expect(() => assertTransition('PAY_ON_EXIT', 'ACTIVE', 'CANCELLED', { reason: 'wrong vehicle', actorRole: 'ORG_ADMIN' })).not.toThrow()
  })

  test('cancellation requires a reason', () => {
    expect(() => assertTransition('PAY_ON_EXIT', 'CREATED', 'CANCELLED', { actorRole: 'MANAGER' })).toThrow(/reason is required/i)
  })

  test('Staff cannot cancel a session', () => {
    expect(() => assertTransition('PAY_ON_EXIT', 'CREATED', 'CANCELLED', { reason: 'oops', actorRole: 'STAFF' })).toThrow(/manager or org admin/i)
  })

  test('EXIT_REQUESTED can no longer be cancelled', () => {
    expect(canTransition('PAY_ON_EXIT', 'EXIT_REQUESTED', 'CANCELLED')).toBe(false)
  })
})

describe('sessionStateMachine — PAY_ON_ENTRY / FIXED_DURATION', () => {
  test.each(['PAY_ON_ENTRY', 'FIXED_DURATION'])('%s: amount is captured before ACTIVE', (mode) => {
    expect(() => assertTransition(mode, 'CREATED', 'PAYMENT_PENDING')).not.toThrow()
    expect(() => assertTransition(mode, 'PAYMENT_PENDING', 'PAID')).not.toThrow()
    expect(() => assertTransition(mode, 'PAID', 'ACTIVE')).not.toThrow()
    expect(() => assertTransition(mode, 'ACTIVE', 'EXIT_REQUESTED')).not.toThrow()
    expect(() => assertTransition(mode, 'EXIT_REQUESTED', 'COMPLETED')).not.toThrow()
  })

  test.each(['PAY_ON_ENTRY', 'FIXED_DURATION'])('%s: can be cancelled from PAYMENT_PENDING (before paying) — the realistic cancel point, since CREATED is never actually observed', (mode) => {
    expect(() => assertTransition(mode, 'PAYMENT_PENDING', 'CANCELLED', { reason: 'customer changed their mind', actorRole: 'MANAGER' })).not.toThrow()
  })

  test('cannot skip payment and go straight to ACTIVE', () => {
    expect(canTransition('PAY_ON_ENTRY', 'CREATED', 'ACTIVE')).toBe(false)
  })
})

describe('sessionStateMachine — terminal states, the "no double exit" guarantee', () => {
  test.each(['COMPLETED', 'CANCELLED'])('%s rejects every further transition', (terminal) => {
    expect(() => assertTransition('PAY_ON_EXIT', terminal, 'ACTIVE')).toThrow(/already completed/i)
    expect(() => assertTransition('PAY_ON_EXIT', terminal, 'COMPLETED')).toThrow(/already completed/i)
  })

  test('the rejection carries the SESSION_ALREADY_TERMINAL code the sync/API layers switch on', () => {
    try {
      assertTransition('PAY_ON_EXIT', 'COMPLETED', 'ACTIVE')
      throw new Error('expected assertTransition to throw')
    } catch (err) {
      expect(err.code).toBe('SESSION_ALREADY_TERMINAL')
      expect(err.statusCode).toBe(409)
    }
  })
})

describe('sessionStateMachine — unknown mode/status', () => {
  test('rejects an unrecognized pricing mode', () => {
    expect(() => assertTransition('SOMETHING_ELSE', 'CREATED', 'ACTIVE')).toThrow(/unknown pricing mode/i)
  })

  test('rejects an unrecognized "from" status', () => {
    expect(() => assertTransition('PAY_ON_EXIT', 'NOT_A_REAL_STATUS', 'ACTIVE')).toThrow(/unknown session status/i)
  })
})
