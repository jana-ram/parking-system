const { classifySyncFailure } = require('../syncConflictPolicy')

function errWithCode(code, message = 'boom') {
  const e = new Error(message)
  e.code = code
  return e
}

describe('syncConflictPolicy.classifySyncFailure', () => {
  test.each([
    'TOKEN_ALREADY_ACTIVE', 'TOKEN_INVALID_STATUS', 'TOKEN_LOCATION_MISMATCH', 'TOKEN_ORG_MISMATCH',
    'VEHICLE_ALREADY_ACTIVE', 'SESSION_ALREADY_TERMINAL', 'SESSION_INVALID_TRANSITION',
    'SHIFT_ALREADY_CLOSED', 'SHIFT_NOT_ACTIVE', 'SHIFT_INVALID_TRANSITION',
    'VALIDATION_ERROR', 'LOCATION_VERIFICATION_FAILED', 'DEVICE_DEACTIVATED', 'FORBIDDEN_ROLE', 'NOT_FOUND',
  ])('%s is a permanent REJECTED outcome, never retried', (code) => {
    const result = classifySyncFailure(errWithCode(code))
    expect(result.outcome).toBe('REJECTED')
    expect(result.code).toBe(code)
  })

  test('an unrecognized/transient error is RETRYABLE', () => {
    const result = classifySyncFailure(errWithCode('ECONNRESET', 'connection reset'))
    expect(result.outcome).toBe('RETRYABLE')
  })

  test('an error with no code at all is treated as RETRYABLE, not silently dropped', () => {
    const result = classifySyncFailure(new Error('something unexpected'))
    expect(result.outcome).toBe('RETRYABLE')
    expect(result.code).toBe('UNKNOWN_ERROR')
    expect(result.message).toBe('something unexpected')
  })
})
