/**
 * LuggagePayment — append-only payment ledger for a LuggageOrder, same shape
 * and intent as Payment.js (§13/§14: never overwrite, multiple/partial
 * payments, full audit trail) but a separate collection rather than widening
 * Payment.js's required `parkingSessionId` — see LuggageOrder.js's header
 * for why.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'OTHER']
const PAYMENT_STATUSES = ['PAID', 'REFUNDED']

const LuggagePaymentSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'LuggageOrder', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  method: { type: String, enum: PAYMENT_METHODS, required: true },
  status: { type: String, enum: PAYMENT_STATUSES, default: 'PAID' },
  amountMinor: { type: Number, required: true },
  currency: { type: String, required: true, uppercase: true },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
  shiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance', required: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
  clientTransactionId: { type: String, required: true },
}, { timestamps: true })

LuggagePaymentSchema.index({ organizationId: 1, clientTransactionId: 1 }, { unique: true })
LuggagePaymentSchema.statics.METHODS = PAYMENT_METHODS
LuggagePaymentSchema.statics.STATUSES = PAYMENT_STATUSES
LuggagePaymentSchema.plugin(requireOrgScope)

module.exports = mongoose.model('LuggagePayment', LuggagePaymentSchema)
