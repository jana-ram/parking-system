/**
 * occupySlot / vacateSlot — the shared core of rack-slot assignment, factored
 * out of rack.controller.js (Phase 13) so any item-type controller (Luggage,
 * Parcel, ...) can place/remove itself from a RackSlot by passing a generic
 * itemType/itemRef pair, without re-implementing the status-transition +
 * movement + audit trio. Takes explicit params rather than `req` — same
 * convention as session.service.js — so it stays callable from any
 * controller without a mocked Express request.
 */
const RackSlot = require('../models/RackSlot')
const RackSlotMovement = require('../models/RackSlotMovement')
const auditLog = require('./auditLog.service')
const { createError } = require('../utils/helpers')

async function occupySlot({ slotId, organizationId, itemType, itemRef, actorUserId, actorRole, actorName, deviceId, shiftInstanceId, reason }) {
  const slot = await RackSlot.findOne({ _id: slotId, organizationId })
  if (!slot) throw createError(404, 'Rack slot not found', null, 'NOT_FOUND')

  if (!['AVAILABLE', 'RESERVED'].includes(slot.status)) {
    throw createError(409, `Cannot assign a slot that is ${slot.status}`, null, 'RACK_SLOT_INVALID_STATUS')
  }
  if (Array.isArray(slot.allowedItemTypes) && slot.allowedItemTypes.length && !slot.allowedItemTypes.includes(itemType)) {
    throw createError(422, `This slot does not accept ${itemType}`, null, 'RACK_SLOT_ITEM_TYPE_MISMATCH')
  }

  const fromStatus = slot.status
  slot.status = 'OCCUPIED'
  slot.currentItemType = itemType
  slot.currentItemRef = itemRef
  slot.occupiedAt = new Date()
  await slot.save()

  await RackSlotMovement.create({
    organizationId, slotId: slot._id, fromStatus, toStatus: 'OCCUPIED',
    itemType, itemRef, actorUserId, deviceId, locationId: slot.locationId, shiftInstanceId, reason,
  })

  await auditLog.recordSystem({
    organizationId, actorId: actorUserId, actorRole, actorName,
    action: 'RACK_SLOT_ASSIGNED', entityType: 'RackSlot', entityId: slot._id,
    oldValue: { status: fromStatus }, newValue: { status: 'OCCUPIED', itemType, itemRef },
    deviceId, locationId: slot.locationId, shiftInstanceId,
  })

  return slot
}

async function vacateSlot({ slotId, organizationId, actorUserId, actorRole, actorName, deviceId, shiftInstanceId, reason }) {
  const slot = await RackSlot.findOne({ _id: slotId, organizationId })
  if (!slot) throw createError(404, 'Rack slot not found', null, 'NOT_FOUND')

  if (slot.status !== 'OCCUPIED') {
    throw createError(409, `Cannot release a slot that is ${slot.status}`, null, 'RACK_SLOT_INVALID_STATUS')
  }

  const { currentItemType: itemType, currentItemRef: itemRef } = slot
  slot.status = 'AVAILABLE'
  slot.currentItemType = null
  slot.currentItemRef = null
  slot.occupiedAt = null
  await slot.save()

  await RackSlotMovement.create({
    organizationId, slotId: slot._id, fromStatus: 'OCCUPIED', toStatus: 'AVAILABLE',
    itemType, itemRef, actorUserId, deviceId, locationId: slot.locationId, shiftInstanceId, reason,
  })

  await auditLog.recordSystem({
    organizationId, actorId: actorUserId, actorRole, actorName,
    action: 'RACK_SLOT_RELEASED', entityType: 'RackSlot', entityId: slot._id,
    oldValue: { status: 'OCCUPIED', itemType, itemRef }, newValue: { status: 'AVAILABLE' },
    deviceId, locationId: slot.locationId, shiftInstanceId,
  })

  return slot
}

module.exports = { occupySlot, vacateSlot }
