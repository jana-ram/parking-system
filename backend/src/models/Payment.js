const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'OTHER']
const PAYMENT_STATUSES = ['PENDING', 'PAID', 'PARTIALLY_PAID', 'FAILED', 'REFUNDED', 'CANCELLED']

const PaymentSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  parkingSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParkingSession', required: true, index: true },
  method: { type: String, enum: PAYMENT_METHODS, required: true },
  status: { type: String, enum: PAYMENT_STATUSES, default: 'PENDING' },
  amountMinor: { type: Number, required: true },
  currency: { type: String, required: true, uppercase: true },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
  shiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance', required: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
  clientTransactionId: { type: String, required: true },
}, { timestamps: true })

PaymentSchema.index({ organizationId: 1, clientTransactionId: 1 }, { unique: true })
PaymentSchema.statics.METHODS = PAYMENT_METHODS
PaymentSchema.statics.STATUSES = PAYMENT_STATUSES
PaymentSchema.plugin(requireOrgScope)

module.exports = mongoose.model('Payment', PaymentSchema)
