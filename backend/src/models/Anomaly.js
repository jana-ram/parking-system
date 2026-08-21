/**
 * Anomaly — explainable risk-scoring output of src/services/anomaly.service.js
 * (§20, §R). `reasons` is always populated with the contributing rules so a
 * reviewer sees exactly why a subject was flagged — never a bare score.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const SUBJECT_TYPES = ['STAFF', 'SHIFT', 'DEVICE', 'LOCATION']
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const ANOMALY_STATUSES = ['OPEN', 'REVIEWED', 'DISMISSED']

const AnomalySchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  subjectType: { type: String, enum: SUBJECT_TYPES, required: true },
  subjectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  riskScore: { type: Number, required: true },
  riskLevel: { type: String, enum: RISK_LEVELS, required: true },
  reasons: {
    type: [{ rule: String, weight: Number, detail: String }],
    required: true,
  },
  status: { type: String, enum: ANOMALY_STATUSES, default: 'OPEN' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' },
}, { timestamps: true })

AnomalySchema.index({ organizationId: 1, status: 1, riskLevel: 1 })
AnomalySchema.statics.SUBJECT_TYPES = SUBJECT_TYPES
AnomalySchema.statics.RISK_LEVELS = RISK_LEVELS
AnomalySchema.statics.STATUSES = ANOMALY_STATUSES
AnomalySchema.plugin(requireOrgScope)

module.exports = mongoose.model('Anomaly', AnomalySchema)
