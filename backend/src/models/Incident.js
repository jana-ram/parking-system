/**
 * Incident — deliberately NOT guarded by requireOrgScope: organizationId is
 * intentionally nullable here (a platform-level incident, e.g. a sync-retry
 * storm affecting the whole cluster, belongs to no single tenant). Every
 * tenant-scoped query against this collection must still filter explicitly by
 * organizationId in the controller — this is the one collection where that's
 * a manual discipline rather than a plugin-enforced guarantee, precisely
 * because "no organizationId" is sometimes the correct, valid query.
 */
const mongoose = require('mongoose')

const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED']

const IncidentSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
  type: { type: String, required: true },
  severity: { type: String, enum: INCIDENT_SEVERITIES, required: true },
  entityType: String,
  entityId: mongoose.Schema.Types.ObjectId,
  description: { type: String, required: true },
  status: { type: String, enum: INCIDENT_STATUSES, default: 'OPEN' },
  resolvedAt: Date,
}, { timestamps: true })

IncidentSchema.index({ organizationId: 1, status: 1 })
IncidentSchema.statics.SEVERITIES = INCIDENT_SEVERITIES
IncidentSchema.statics.STATUSES = INCIDENT_STATUSES

module.exports = mongoose.model('Incident', IncidentSchema)
