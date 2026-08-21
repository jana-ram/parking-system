const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const SUBSCRIPTION_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED']

const SubscriptionSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
  status: { type: String, enum: SUBSCRIPTION_STATUSES, required: true },
  currentPeriodStart: { type: Date, required: true },
  currentPeriodEnd: { type: Date, required: true },
}, { timestamps: true })

SubscriptionSchema.statics.STATUSES = SUBSCRIPTION_STATUSES
SubscriptionSchema.plugin(requireOrgScope)

module.exports = mongoose.model('Subscription', SubscriptionSchema)
