/**
 * shiftStateMachine.js — pure functions enforcing the ShiftInstance lifecycle
 * from docs/ARCHITECTURE.md §H. ABANDONED is the one state reachable without
 * the owning staff's own action (§14's admin override) — gated so it can
 * never be reached silently.
 */
const { createError } = require('../utils/helpers')

const STATUSES = ['OPEN', 'TALLY_PENDING', 'CLOSED', 'HANDED_OVER', 'ABANDONED']
const TERMINAL_STATUSES = ['HANDED_OVER', 'ABANDONED']

const TRANSITIONS = {
  OPEN: ['TALLY_PENDING', 'ABANDONED'],
  TALLY_PENDING: ['CLOSED', 'ABANDONED'],
  CLOSED: ['HANDED_OVER'],
  HANDED_OVER: [],
  ABANDONED: [],
}

function canTransition(from, to) {
  const allowed = TRANSITIONS[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

function assertTransition(from, to, { isAdminOverride = false, reason } = {}) {
  if (!STATUSES.includes(from)) {
    throw createError(500, `Unknown shift status "${from}"`, null, 'SHIFT_STATUS_INVALID')
  }
  if (TERMINAL_STATUSES.includes(from)) {
    throw createError(409, `Shift is already ${from}`, null, 'SHIFT_ALREADY_CLOSED')
  }
  if (!canTransition(from, to)) {
    throw createError(409, `Cannot transition shift from ${from} to ${to}`, null, 'SHIFT_INVALID_TRANSITION')
  }
  if (to === 'ABANDONED') {
    if (!isAdminOverride) {
      throw createError(403, 'Abandoning a shift requires an explicit admin override', null, 'SHIFT_ABANDON_REQUIRES_ADMIN')
    }
    if (!reason) {
      throw createError(422, 'A reason is required to force-close a shift', null, 'VALIDATION_ERROR')
    }
  }
  return true
}

module.exports = { STATUSES, TERMINAL_STATUSES, TRANSITIONS, canTransition, assertTransition }
