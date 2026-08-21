/**
 * tokenStateMachine.js — pure functions enforcing the QrToken lifecycle from
 * docs/ARCHITECTURE.md §G. No I/O, no Mongoose — controllers/services call
 * assertTransition() before writing QrToken.status, inside the same
 * transaction as the resulting TokenMovement insert.
 */
const { createError } = require('../utils/helpers')

const STATUSES = ['AVAILABLE', 'ASSIGNED', 'ACTIVE', 'RETURNED', 'LOST', 'DAMAGED', 'BLOCKED']

const TRANSITIONS = {
  AVAILABLE: ['ASSIGNED', 'LOST', 'DAMAGED', 'BLOCKED'],
  ASSIGNED: ['ACTIVE', 'LOST'],
  ACTIVE: ['RETURNED', 'LOST'],
  RETURNED: ['AVAILABLE', 'DAMAGED'],
  LOST: ['AVAILABLE'],
  DAMAGED: ['AVAILABLE'],
  BLOCKED: ['AVAILABLE'],
}

// LOST/DAMAGED/BLOCKED -> AVAILABLE is only ever a manual, admin-authorized
// reinstate (§6: "cannot be reused until explicitly authorized") — reachable
// in the table above, but gated separately so a code path can't casually
// re-enable a lost token the way it can casually return one.
const REINSTATE_SOURCES = new Set(['LOST', 'DAMAGED', 'BLOCKED'])

function canTransition(from, to) {
  const allowed = TRANSITIONS[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

function assertTransition(from, to, { authorizedReinstate = false, reason } = {}) {
  if (!STATUSES.includes(from)) {
    throw createError(500, `Unknown token status "${from}"`, null, 'TOKEN_STATUS_INVALID')
  }
  if (!canTransition(from, to)) {
    throw createError(409, `Cannot transition token from ${from} to ${to}`, null, 'TOKEN_INVALID_STATUS')
  }
  if (REINSTATE_SOURCES.has(from) && to === 'AVAILABLE') {
    if (!authorizedReinstate) {
      throw createError(
        403,
        `Reinstating a token from ${from} requires explicit admin authorization`,
        null,
        'TOKEN_REINSTATE_REQUIRES_AUTHORIZATION'
      )
    }
    if (!reason) {
      throw createError(422, 'A reason is required to reinstate a token', null, 'VALIDATION_ERROR')
    }
  }
  return true
}

module.exports = { STATUSES, TRANSITIONS, REINSTATE_SOURCES, canTransition, assertTransition }
