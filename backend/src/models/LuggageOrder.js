/**
 * LuggageOrder — the customer-facing header a set of LuggageItem.js docs are
 * grouped under (§8: "multiple luggage items under a single customer/
 * order"). Carries the money fields directly (mirrors ParkingSession's
 * amountDueMinor/amountPaidMinor), with LuggagePayment.js as the append-only
 * ledger of individual payment attempts against it — same two-tier shape as
 * ParkingSession/Payment, kept as a SEPARATE collection rather than widening
 * Payment.js's schema, since Payment.parkingSessionId is required and relied
 * on by existing report/reconciliation queries — a nullable/polymorphic
 * rework there is a real migration risk this phase doesn't need to take on.
 *
 * Pricing is deliberately a flat per-day rate set at check-in (domain/
 * luggagePricing.js), not the full versioned PricingRuleVersion engine
 * ParkingSession uses (§10/§11) — simplest thing that's still real and
 * auditable; revisit if luggage needs hourly/peak/holiday tiers later.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const ORDER_STATUSES = ['ACTIVE', 'COMPLETED', 'CANCELLED']

const LuggageOrderSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true, index: true },
  orderCode: { type: String, required: true },
  customerName: { type: String, required: true, trim: true },
  customerPhone: { type: String, required: true, trim: true },
  status: { type: String, enum: ORDER_STATUSES, default: 'ACTIVE' },
  ratePerDayMinor: { type: Number, required: true },
  currency: { type: String, required: true, uppercase: true },
  checkInAt: { type: Date, default: Date.now },
  expectedPickupAt: Date,
  actualPickupAt: Date,
  amountDueMinor: { type: Number, default: 0 },
  amountPaidMinor: { type: Number, default: 0 },
  // §12 manual-amount override — when set, payment/pickup use this fixed
  // value instead of recomputing from ratePerDayMinor/checkInAt. Always set
  // through services/luggage.service.js's overrideAmount(), which records a
  // Correction; never written directly.
  manualAmountOverrideMinor: { type: Number, default: null },
  // Set once by overdueAlert.service.js's scanAndNotifyOverdue() the first
  // time this order is found overdue — makes the sweep idempotent (one
  // Manager/Admin alert per order, not one per sweep interval) without
  // needing a separate log collection.
  overdueNotifiedAt: { type: Date, default: null },
  cancelReason: String,
  createdByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
  shiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance', required: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
  notes: String,
}, { timestamps: true })

LuggageOrderSchema.index({ organizationId: 1, orderCode: 1 }, { unique: true })
LuggageOrderSchema.statics.STATUSES = ORDER_STATUSES
LuggageOrderSchema.plugin(requireOrgScope)

module.exports = mongoose.model('LuggageOrder', LuggageOrderSchema)
