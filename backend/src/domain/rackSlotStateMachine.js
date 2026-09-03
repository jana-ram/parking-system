/**
 * rackSlotStateMachine.js — pure functions enforcing the manual (staff-
 * initiated) RackSlot status transitions. No I/O, no Mongoose, same shape as
 * tokenStateMachine.js.
 *
 * OCCUPIED is deliberately unreachable from and to this table: a slot only
 * becomes OCCUPIED via assignSlot() and only leaves it via releaseSlot()
 * (rack.controller.js), each of which also stamps currentItemType/
 * currentItemRef/occupiedAt — routing that through a generic status-change
 * endpoint would let staff silently orphan a live item assignment.
 */
const { createError } = require('../utils/helpers')

const STATUSES = ['AVAILABLE', 'OCCUPIED', 'RESERVED', 'BLOCKED', 'MAINTENANCE']

const TRANSITIONS = {
  AVAILABLE: ['RESERVED', 'BLOCKED', 'MAINTENANCE'],
  RESERVED: ['AVAILABLE', 'BLOCKED', 'MAINTENANCE'],
  BLOCKED: ['AVAILABLE'],
  MAINTENANCE: ['AVAILABLE'],
  OCCUPIED: [],
}

function canTransition(from, to) {
  const allowed = TRANSITIONS[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

function assertTransition(from, to, { reason } = {}) {
  if (!STATUSES.includes(from)) {
    throw createError(500, `Unknown rack slot status "${from}"`, null, 'RACK_SLOT_STATUS_INVALID')
  }
  if (!canTransition(from, to)) {
    throw createError(409, `Cannot transition rack slot from ${from} to ${to}`, null, 'RACK_SLOT_INVALID_STATUS')
  }
  if (!reason) {
    throw createError(422, "A reason is required to change a rack slot's status", null, 'VALIDATION_ERROR')
  }
  return true
}

module.exports = { STATUSES, TRANSITIONS, canTransition, assertTransition }
