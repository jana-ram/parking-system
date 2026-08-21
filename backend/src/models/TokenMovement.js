/**
 * TokenMovement — append-only log of every QrToken status transition (§6, §21).
 * Written inside the same transaction as the transition itself (never as an
 * afterthought), so the token's full history is always complete.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const TokenMovementSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  tokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'QrToken', required: true, index: true },
  fromStatus: { type: String, required: true },
  toStatus: { type: String, required: true },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParkingSession' },
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  shiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance' },
  reason: String,
}, { timestamps: true })

TokenMovementSchema.index({ tokenId: 1, createdAt: -1 })
TokenMovementSchema.plugin(requireOrgScope)

module.exports = mongoose.model('TokenMovement', TokenMovementSchema)
