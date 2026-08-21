/**
 * Correction — the generic reversal/correction ledger (§21). Completed
 * transactions are never edited in place; this collection is the only way an
 * "old value -> new value" change to a completed/immutable record is recorded.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const CorrectionSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  entityType: { type: String, required: true }, // 'ParkingSession' | 'Payment' | ...
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
  field: { type: String, required: true },
  oldValue: mongoose.Schema.Types.Mixed,
  newValue: mongoose.Schema.Types.Mixed,
  reason: { type: String, required: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' },
}, { timestamps: true })

CorrectionSchema.index({ entityType: 1, entityId: 1 })
CorrectionSchema.plugin(requireOrgScope)

module.exports = mongoose.model('Correction', CorrectionSchema)
