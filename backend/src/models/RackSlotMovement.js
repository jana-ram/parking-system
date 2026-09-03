/**
 * RackSlotMovement — append-only log of every RackSlot status transition
 * (§16/§21), same shape and purpose as TokenMovement.js: written alongside
 * the transition itself so a slot's full history (who assigned/released/
 * blocked it, when, why) is always complete, never reconstructed after the
 * fact.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const RackSlotMovementSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  slotId: { type: mongoose.Schema.Types.ObjectId, ref: 'RackSlot', required: true, index: true },
  fromStatus: { type: String, required: true },
  toStatus: { type: String, required: true },
  itemType: String,
  itemRef: String,
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  shiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance' },
  reason: String,
}, { timestamps: true })

RackSlotMovementSchema.index({ slotId: 1, createdAt: -1 })
RackSlotMovementSchema.plugin(requireOrgScope)

module.exports = mongoose.model('RackSlotMovement', RackSlotMovementSchema)
