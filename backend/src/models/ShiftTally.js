/**
 * ShiftTally — immutable snapshot computed ONCE at shift close (§15). Never
 * recalculated in place; a correction to a closed tally goes through
 * Correction.js instead, same as a completed session would.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const ShiftTallySchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  shiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance', required: true, unique: true },
  entriesCount: { type: Number, required: true },
  exitsCount: { type: Number, required: true },
  expectedCashMinor: { type: Number, required: true },
  expectedUpiMinor: { type: Number, required: true },
  expectedCardMinor: { type: Number, required: true },
  discountsMinor: { type: Number, default: 0 },
  cancellationsCount: { type: Number, default: 0 },
  refundsMinor: { type: Number, default: 0 },
  correctionsCount: { type: Number, default: 0 },
  actualCashMinor: { type: Number, required: true },
  varianceMinor: { type: Number, required: true }, // actual - expected, can be negative
  mismatchReason: String,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' }, // required if |variance| > org threshold
}, { timestamps: true })

ShiftTallySchema.plugin(requireOrgScope)

module.exports = mongoose.model('ShiftTally', ShiftTallySchema)
