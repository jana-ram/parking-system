/**
 * Plan — SaaS subscription plans sold to organizations. Platform reference
 * data, managed from the Product Owner dashboard only (§T).
 */
const mongoose = require('mongoose')

const BILLING_CYCLES = ['MONTHLY', 'ANNUAL']

const PlanSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  billingCycle: { type: String, enum: BILLING_CYCLES, required: true },
  priceMinor: { type: Number, required: true },
  currency: { type: String, required: true, uppercase: true },
  locationLimit: Number,
  deviceLimit: Number,
  features: { type: mongoose.Schema.Types.Mixed, default: {} },
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

PlanSchema.statics.BILLING_CYCLES = BILLING_CYCLES

module.exports = mongoose.model('Plan', PlanSchema)
