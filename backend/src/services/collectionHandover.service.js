const CollectionHandover = require('../models/CollectionHandover')
const ShiftInstance = require('../models/ShiftInstance')
const ShiftTally = require('../models/ShiftTally')
const auditLog = require('./auditLog.service')
const { createError } = require('../utils/helpers')

/**
 * initiateCollectionHandover — a shift's cash can only be handed over once
 * it's been tallied (ShiftTally existing is the real gate, not the
 * ShiftInstance.status enum — a shift can independently also be HANDED_OVER
 * to the next staff member via ShiftHandover, which this never touches).
 */
async function initiateCollectionHandover({ organizationId, actorStaffUser, shiftInstance, amountMinor, notes }) {
  const tally = await ShiftTally.findOne({ organizationId, shiftInstanceId: shiftInstance._id })
  if (!tally) {
    throw createError(409, 'This shift has not been closed and tallied yet', null, 'SHIFT_INVALID_TRANSITION')
  }

  let handover
  try {
    handover = await CollectionHandover.create({
      organizationId,
      locationId: shiftInstance.locationId,
      shiftInstanceId: shiftInstance._id,
      staffId: shiftInstance.staffId,
      amountMinor,
      notes,
    })
  } catch (err) {
    if (err.code === 11000) {
      throw createError(409, 'A collection handover for this shift is already pending confirmation', null, 'COLLECTION_HANDOVER_ALREADY_PENDING')
    }
    throw err
  }

  await auditLog.recordSystem({
    organizationId, actorId: actorStaffUser._id, actorRole: actorStaffUser.role, actorName: actorStaffUser.name,
    action: 'COLLECTION_HANDOVER_INITIATED', entityType: 'CollectionHandover', entityId: handover._id,
    newValue: { amountMinor, shiftInstanceId: shiftInstance._id },
    locationId: shiftInstance.locationId, shiftInstanceId: shiftInstance._id,
  })

  return handover
}

/** confirmCollectionHandover — Manager/Org Admin records what they actually counted on receipt; a mismatch is recorded, never silently corrected. */
async function confirmCollectionHandover({ organizationId, actorStaffUser, handover, receivedAmountMinor, notes }) {
  if (handover.status !== 'PENDING') {
    throw createError(409, `Collection handover is already ${handover.status.toLowerCase()}`, null, 'VALIDATION_ERROR')
  }

  handover.status = 'CONFIRMED'
  handover.receivedByStaffId = actorStaffUser._id
  handover.receivedAmountMinor = receivedAmountMinor
  handover.varianceMinor = receivedAmountMinor - handover.amountMinor
  handover.confirmNotes = notes
  handover.confirmedAt = new Date()
  await handover.save()

  await auditLog.recordSystem({
    organizationId, actorId: actorStaffUser._id, actorRole: actorStaffUser.role, actorName: actorStaffUser.name,
    action: 'COLLECTION_HANDOVER_CONFIRMED', entityType: 'CollectionHandover', entityId: handover._id,
    newValue: { receivedAmountMinor, varianceMinor: handover.varianceMinor },
    locationId: handover.locationId, shiftInstanceId: handover.shiftInstanceId,
  })

  return handover
}

/** rejectCollectionHandover — e.g. the claimed amount was wrong before any cash changed hands; staff can re-initiate afterward (PENDING uniqueness only blocks a SECOND pending claim). */
async function rejectCollectionHandover({ organizationId, actorStaffUser, handover, reason }) {
  if (handover.status !== 'PENDING') {
    throw createError(409, `Collection handover is already ${handover.status.toLowerCase()}`, null, 'VALIDATION_ERROR')
  }

  handover.status = 'REJECTED'
  handover.receivedByStaffId = actorStaffUser._id
  handover.rejectionReason = reason
  handover.rejectedAt = new Date()
  await handover.save()

  await auditLog.recordSystem({
    organizationId, actorId: actorStaffUser._id, actorRole: actorStaffUser.role, actorName: actorStaffUser.name,
    action: 'COLLECTION_HANDOVER_REJECTED', entityType: 'CollectionHandover', entityId: handover._id,
    newValue: { reason }, locationId: handover.locationId, shiftInstanceId: handover.shiftInstanceId,
  })

  return handover
}

module.exports = { initiateCollectionHandover, confirmCollectionHandover, rejectCollectionHandover }
