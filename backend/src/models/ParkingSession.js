/**
 * ParkingSession — the hottest-write collection in the system. Lifecycle is
 * pricing-mode-aware and enforced by src/domain/sessionStateMachine.js — see
 * docs/ARCHITECTURE.md §F for the full transition table and §1 item 3 for why
 * a single fixed status order doesn't work across all four pricing modes.
 *
 * The two partial-unique indexes below are the actual, DB-enforced guarantee
 * behind "no double exit" and "no duplicate active session" (§1 items 13-14) —
 * they are not just documentation, a controller bug cannot violate them.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const SESSION_STATUSES = ['CREATED', 'ACTIVE', 'EXIT_REQUESTED', 'PAYMENT_PENDING', 'PAID', 'COMPLETED', 'CANCELLED']
const TERMINAL_STATUSES = ['COMPLETED', 'CANCELLED']
const SYNC_STATUSES = ['PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'BLOCKED', 'CONFLICT']
const PRICING_MODES = ['PAY_ON_EXIT', 'PAY_ON_ENTRY', 'FIXED_DURATION', 'HYBRID']

const ParkingSessionSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  parkingAreaId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParkingArea' },
  slotId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParkingSlot' },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true },
  vehicleTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleType', required: true },
  tokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'QrToken', required: true },
  pricingRuleVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'PricingRuleVersion', required: true },
  // [Added during Phase 3 implementation] Denormalized from ParkingPricingRule.mode
  // at entry time, and never re-read from the rule afterward — the session's own
  // state-machine transitions (§F) need a mode that can't drift out from under
  // an in-flight session if an admin edits the rule's mode later (rule.mode
  // itself isn't versioned the way its pricing config is via PricingRuleVersion).
  pricingMode: { type: String, enum: PRICING_MODES, required: true },
  status: { type: String, enum: SESSION_STATUSES, default: 'CREATED' },

  entryStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
  entryShiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance', required: true },
  entryDeviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
  entryAt: { type: Date, required: true },

  exitStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' },
  exitShiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance' },
  exitDeviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' },
  exitAt: Date,

  amountDueMinor: Number,
  amountPaidMinor: { type: Number, default: 0 },
  currency: { type: String, required: true, uppercase: true },
  cancelReason: String,

  // [Added for fixed-entry/no-exit locations] Denormalized at entry time from
  // the resolved pricingMode + the location's fixedEntryNoExit toggle, same
  // reasoning as pricingMode itself: can't drift out from under an in-flight
  // session if the location's flag is edited later. Read-side UX metadata
  // only — does NOT gate sessionStateMachine transitions; a staff exit scan
  // remains fully possible (and still the only way to free the token) even
  // when this is false, it's simply optional rather than mandatory.
  exitRequired: { type: Boolean, default: true },

  clientTransactionId: { type: String, required: true }, // idempotency key, generated on-device at CREATE
  syncStatus: { type: String, enum: SYNC_STATUSES, default: 'SYNCED' },

  // [Fixed during Phase 3 build] MongoDB's partialFilterExpression only
  // supports $eq/$exists/comparisons/$and — NOT $nin, $not, $ne, or $or. A
  // literal `{status: {$nin: TERMINAL_STATUSES}}` partial filter is REJECTED
  // by the server at index-creation time (this was caught by Mongoose's
  // background autoIndex only once something finally forced eager index
  // building — see config/db.js's Model.init() fix, which is what surfaced
  // this in the first place). This boolean is the standard MongoDB workaround:
  // true while the session is non-terminal, flipped to false by the pre-save
  // hook below the instant status becomes COMPLETED/CANCELLED, and the
  // partial index below matches on simple equality instead.
  isActiveSession: { type: Boolean, default: true },
}, { timestamps: true })

ParkingSessionSchema.pre('save', function syncIsActiveSession(next) {
  this.isActiveSession = !TERMINAL_STATUSES.includes(this.status)
  next()
})

ParkingSessionSchema.index({ organizationId: 1, clientTransactionId: 1 }, { unique: true })
// §1 items 13-14: at most one non-terminal session per vehicle, and per token, per org.
ParkingSessionSchema.index(
  { organizationId: 1, vehicleId: 1 },
  { unique: true, partialFilterExpression: { isActiveSession: true } }
)
ParkingSessionSchema.index(
  { organizationId: 1, tokenId: 1 },
  { unique: true, partialFilterExpression: { isActiveSession: true } }
)
ParkingSessionSchema.index({ organizationId: 1, status: 1 })
ParkingSessionSchema.index({ locationId: 1, status: 1 })

ParkingSessionSchema.statics.STATUSES = SESSION_STATUSES
ParkingSessionSchema.statics.TERMINAL_STATUSES = TERMINAL_STATUSES
ParkingSessionSchema.plugin(requireOrgScope)

module.exports = mongoose.model('ParkingSession', ParkingSessionSchema)
