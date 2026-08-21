/**
 * syncConflictPolicy.js — the §K decision table distilled into one function.
 * "The server never guesses" (§K): every business-rule error our own service
 * layer already throws (TOKEN_ALREADY_ACTIVE, SESSION_ALREADY_TERMINAL, ...)
 * represents a case where two writers raced and one legitimately lost — that
 * is NOT a transient failure worth retrying, it's a permanent outcome that
 * needs a human to see it (§K: "auto-flagged, not silently dropped"). Anything
 * NOT in this list (a DB hiccup, a timeout) is assumed transient and goes
 * through the bounded-retry schedule in retryPolicy.js instead.
 *
 * This list is intentionally the same closed vocabulary of error codes used
 * across the API (§Q) — a new permanent-rejection code needs a deliberate
 * decision to add it here, not an accident of what error happened to bubble
 * up from a service function.
 */
const PERMANENT_REJECTION_CODES = new Set([
  // Token/vehicle/session state races — §K's core "first valid write wins" cases.
  'TOKEN_ALREADY_ACTIVE',
  'TOKEN_INVALID_STATUS',
  'TOKEN_LOCATION_MISMATCH',
  'TOKEN_ORG_MISMATCH',
  'VEHICLE_ALREADY_ACTIVE',
  'SESSION_ALREADY_TERMINAL',
  'SESSION_INVALID_TRANSITION',
  // Shift races — e.g. server-side force-close while the device was offline.
  'SHIFT_ALREADY_CLOSED',
  'SHIFT_NOT_ACTIVE',
  'SHIFT_INVALID_TRANSITION',
  // Not races, but equally not worth retrying — retrying bad input forever
  // wastes the same backoff budget a real transient failure needs.
  'VALIDATION_ERROR',
  'PRICING_CONFIG_INCOMPLETE',
  'PRICING_CONFIG_INVALID',
  'LOCATION_VERIFICATION_FAILED',
  'DEVICE_NOT_AUTHORIZED',
  'DEVICE_DEACTIVATED',
  'FORBIDDEN_ROLE',
  'NOT_FOUND',
])

/**
 * @param {Error & {code?: string}} err
 * @returns {{ outcome: 'REJECTED' | 'RETRYABLE', code: string, message: string }}
 */
function classifySyncFailure(err) {
  const code = err && err.code
  if (code && PERMANENT_REJECTION_CODES.has(code)) {
    return { outcome: 'REJECTED', code, message: err.message }
  }
  return { outcome: 'RETRYABLE', code: code || 'UNKNOWN_ERROR', message: (err && err.message) || 'Unknown error' }
}

module.exports = { PERMANENT_REJECTION_CODES, classifySyncFailure }
