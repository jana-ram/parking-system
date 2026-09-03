/**
 * ParcelPayment — append-only payment ledger for a ParcelOrder. Structurally
 * identical to LuggagePayment.js — see LuggageOrder.js's header for why this
 * is a separate collection rather than reusing Payment.js.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'OTHER']
const PAYMENT_STATUSES = ['PAID', 'REFUNDED']

const ParcelPaymentSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParcelOrder', required: true, index: true },
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

ParcelPaymentSchema.index({ organizationId: 1, clientTransactionId: 1 }, { unique: true })
ParcelPaymentSchema.statics.METHODS = PAYMENT_METHODS
ParcelPaymentSchema.statics.STATUSES = PAYMENT_STATUSES
ParcelPaymentSchema.plugin(requireOrgScope)

module.exports = mongoose.model('ParcelPayment', ParcelPaymentSchema)
