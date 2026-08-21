/**
 * ShiftInstance — the actual accountable unit of staff/shift/device/location
 * (§13-§14). Lifecycle enforced by src/domain/shiftStateMachine.js — see
 * docs/ARCHITECTURE.md §H for the full transition table.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const SHIFT_INSTANCE_STATUSES = ['OPEN', 'TALLY_PENDING', 'CLOSED', 'HANDED_OVER', 'ABANDONED']

const ShiftInstanceSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  shiftTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftTemplate' },
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
  status: { type: String, enum: SHIFT_INSTANCE_STATUSES, default: 'OPEN' },
  openingCashMinor: { type: Number, default: 0 },
  openedAt: { type: Date, default: Date.now },
  closedAt: Date,
  forceClosedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' }, // admin override, §14
  forceCloseReason: String,
}, { timestamps: true })

ShiftInstanceSchema.index({ locationId: 1, status: 1 })
// One OPEN shift per (staff, device) at a time — prevents one staff member
// silently running two shifts to fragment accountability (§H).
ShiftInstanceSchema.index(
  { staffId: 1, deviceId: 1 },
  { unique: true, partialFilterExpression: { status: 'OPEN' } }
)
ShiftInstanceSchema.statics.STATUSES = SHIFT_INSTANCE_STATUSES
ShiftInstanceSchema.plugin(requireOrgScope)

module.exports = mongoose.model('ShiftInstance', ShiftInstanceSchema)
