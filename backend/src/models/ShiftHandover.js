/**
 * ShiftHandover — scoped to ONE outgoing shift instance → ONE incoming shift
 * instance at one location (§1 item 6), not "the location's shift" globally.
 * Carries the active-vehicle carry-forward snapshot (§17).
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const HANDOVER_STATUSES = ['PENDING', 'ACCEPTED', 'DISPUTED']

const ShiftHandoverSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  fromShiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance', required: true },
  toShiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance', required: true },
  cash: mongoose.Schema.Types.Mixed,
  tokenSummary: mongoose.Schema.Types.Mixed,
  activeVehicleCount: { type: Number, required: true },
  pendingTxnCount: { type: Number, required: true },
  notes: String,
  status: { type: String, enum: HANDOVER_STATUSES, default: 'PENDING' },
  acceptedAt: Date,
}, { timestamps: true })

ShiftHandoverSchema.index({ fromShiftInstanceId: 1, toShiftInstanceId: 1 }, { unique: true })
ShiftHandoverSchema.statics.STATUSES = HANDOVER_STATUSES
ShiftHandoverSchema.plugin(requireOrgScope)

module.exports = mongoose.model('ShiftHandover', ShiftHandoverSchema)
