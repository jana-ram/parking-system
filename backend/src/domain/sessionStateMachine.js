/**
 * sessionStateMachine.js — pure functions enforcing the ParkingSession
 * lifecycle from docs/ARCHITECTURE.md §F. The transition table is
 * pricing-mode-aware (§1 item 3): PAYMENT_PENDING/PAID happens before ACTIVE
 * for entry-priced modes, and after EXIT_REQUESTED for exit-priced modes.
 * COMPLETED and CANCELLED are always the only terminal states, and once in
 * either, EVERY further transition is rejected — this is what makes
 * "no double exit" a guarantee rather than a convention (§1 item 14).
 */
const { createError } = require('../utils/helpers')

const SESSION_STATUSES = ['CREATED', 'ACTIVE', 'EXIT_REQUESTED', 'PAYMENT_PENDING', 'PAID', 'COMPLETED', 'CANCELLED']
const TERMINAL_STATUSES = ['COMPLETED', 'CANCELLED']
const PRICING_MODES = ['PAY_ON_EXIT', 'PAY_ON_ENTRY', 'FIXED_DURATION', 'HYBRID']

// Exit-priced: amount is computed AFTER the exit scan (EXIT_REQUESTED), matching
// the actual flow in §12 — this is the shape that resolves the §1 item 3
// contradiction between the brief's literal §26 ordering and its §12 flow.
const EXIT_PRICED = {
  CREATED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['EXIT_REQUESTED', 'CANCELLED'],
  EXIT_REQUESTED: ['PAYMENT_PENDING'],
  PAYMENT_PENDING: ['PAID'],
  PAID: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
}

// Entry-priced: amount is known upfront, captured before the vehicle is even
// marked ACTIVE.
//
// [Fixed during Phase 6 implementation] CREATED -> CANCELLED alone is dead
// logic in practice: enterVehicle() (services/session.service.js) always
// advances a fresh session past CREATED to its real resting state
// (PAYMENT_PENDING here, ACTIVE in the exit-priced table below) within the
// SAME transaction as creation — a session is never observably sitting at
// CREATED for a later request to act on. The realistic cancel point for this
// mode is "customer decides not to park after all, before paying" —
// PAYMENT_PENDING -> CANCELLED — which is what building the cancel endpoint
// actually surfaced as missing.
const ENTRY_PRICED = {
  CREATED: ['PAYMENT_PENDING', 'CANCELLED'],
  PAYMENT_PENDING: ['PAID', 'CANCELLED'],
  PAID: ['ACTIVE'],
  ACTIVE: ['EXIT_REQUESTED'],
  EXIT_REQUESTED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
}

const TRANSITIONS_BY_MODE = {
  PAY_ON_EXIT: EXIT_PRICED,
  HYBRID: EXIT_PRICED, // deposit-on-entry is a Payment-level PARTIALLY_PAID concern, not a session-status fork
  PAY_ON_ENTRY: ENTRY_PRICED,
  FIXED_DURATION: ENTRY_PRICED,
}

function tableFor(mode) {
  const table = TRANSITIONS_BY_MODE[mode]
  if (!table) {
    throw createError(422, `Unknown pricing mode "${mode}"`, null, 'PRICING_CONFIG_INVALID')
  }
  return table
}

function canTransition(mode, from, to) {
  const allowed = tableFor(mode)[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

function assertTransition(mode, from, to, { reason, actorRole } = {}) {
  if (!SESSION_STATUSES.includes(from)) {
    throw createError(500, `Unknown session status "${from}"`, null, 'SESSION_STATUS_INVALID')
  }
  if (TERMINAL_STATUSES.includes(from)) {
    throw createError(
      409,
      'This transaction is already completed',
      null,
      'SESSION_ALREADY_TERMINAL'
    )
  }
  if (!canTransition(mode, from, to)) {
    throw createError(409, `Cannot transition ${mode} session from ${from} to ${to}`, null, 'SESSION_INVALID_TRANSITION')
  }
  if (to === 'CANCELLED') {
    if (!reason) throw createError(422, 'A reason is required to cancel a session', null, 'VALIDATION_ERROR')
    if (!['MANAGER', 'ORG_ADMIN'].includes(actorRole)) {
      throw createError(403, 'Only a Manager or Org Admin can cancel a parking session', null, 'FORBIDDEN_ROLE')
    }
  }
  return true
}

module.exports = {
  SESSION_STATUSES,
  TERMINAL_STATUSES,
  PRICING_MODES,
  TRANSITIONS_BY_MODE,
  canTransition,
  assertTransition,
}
