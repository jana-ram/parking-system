/**
 * ParcelOrder — the sender/receiver header a set of ParcelItem.js docs are
 * grouped under (§9: "multiple parcels ... grouped under a single order").
 * Structurally a sibling of LuggageOrder.js (same money-field shape, same
 * separate-payment-ledger rationale — see that file's header) with
 * parcel-appropriate fields (sender/receiver instead of one customer).
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const ORDER_STATUSES = ['ACTIVE', 'COMPLETED', 'CANCELLED']

const ParcelOrderSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true, index: true },
  orderCode: { type: String, required: true },
  senderName: { type: String, required: true, trim: true },
  senderPhone: { type: String, trim: true },
  receiverName: { type: String, required: true, trim: true },
  receiverPhone: { type: String, required: true, trim: true },
  status: { type: String, enum: ORDER_STATUSES, default: 'ACTIVE' },
  ratePerDayMinor: { type: Number, required: true },
  // See LuggageOrder.js's identical fields — snapshotted from the resolved
  // ItemPricingRule at check-in, or 'DAY'/null when a manual rate was typed.
  pricingUnit: { type: String, enum: ['HOUR', 'DAY'], default: 'DAY' },
  maxDays: { type: Number, default: null },
  currency: { type: String, required: true, uppercase: true },
  receivedAt: { type: Date, default: Date.now },
  expectedPickupAt: Date,
  actualPickupAt: Date,
  amountDueMinor: { type: Number, default: 0 },
  amountPaidMinor: { type: Number, default: 0 },
  // §12 manual-amount override — see LuggageOrder.js's identical field.
  manualAmountOverrideMinor: { type: Number, default: null },
  // See LuggageOrder.js's identical field — idempotency marker for
  // overdueAlert.service.js.
  overdueNotifiedAt: { type: Date, default: null },
  cancelReason: String,
  createdByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
  shiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance', required: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
  notes: String,
}, { timestamps: true })

ParcelOrderSchema.index({ organizationId: 1, orderCode: 1 }, { unique: true })
ParcelOrderSchema.statics.STATUSES = ORDER_STATUSES
ParcelOrderSchema.plugin(requireOrgScope)

module.exports = mongoose.model('ParcelOrder', ParcelOrderSchema)
