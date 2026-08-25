/**
 * CollectionHandover — a STAFF member depositing the cash they collected
 * during a shift TO an Admin/Manager (office deposit), distinct from
 * ShiftHandover (staff-to-staff shift continuity, §17-§18). Scoped to one
 * CLOSED (tallied) shift instance so the claimed amount can be checked
 * against that shift's own ShiftTally.actualCashMinor.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const COLLECTION_HANDOVER_STATUSES = ['PENDING', 'CONFIRMED', 'REJECTED']

const CollectionHandoverSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  shiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance', required: true },
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true }, // handing the cash over
  amountMinor: { type: Number, required: true }, // claimed by staff at initiate time
  notes: String,
  status: { type: String, enum: COLLECTION_HANDOVER_STATUSES, default: 'PENDING' },
  receivedByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' }, // Manager/Org Admin who acted
  receivedAmountMinor: Number, // set on confirm — may differ from amountMinor
  varianceMinor: Number, // receivedAmountMinor - amountMinor, set on confirm
  confirmNotes: String,
  rejectionReason: String,
  confirmedAt: Date,
  rejectedAt: Date,
}, { timestamps: true })

CollectionHandoverSchema.index({ organizationId: 1, status: 1, createdAt: -1 })
// One outstanding claim per shift at a time — a rejected/confirmed one can
// be superseded by a new attempt, but two PENDING claims for the same
// shift's cash would double-count it.
CollectionHandoverSchema.index(
  { shiftInstanceId: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' } }
)
CollectionHandoverSchema.statics.STATUSES = COLLECTION_HANDOVER_STATUSES
CollectionHandoverSchema.plugin(requireOrgScope)

module.exports = mongoose.model('CollectionHandover', CollectionHandoverSchema)
