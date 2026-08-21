/**
 * AuditLog — append-only trail (§21). Same shape as
 * nammaraidu-web/backend/src/models/AuditLog.js (actorId/actorRole/actorName/
 * action/entityType/entityId/metadata), extended with the fields this
 * multi-tenant, location/device/shift-bound product needs that the
 * single-tenant ride-hailing original never had to carry.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const AuditLogSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, required: true },
  actorRole: { type: String, required: true }, // 'STAFF' | 'MANAGER' | 'ORG_ADMIN' | 'PLATFORM_ADMIN' | 'SYSTEM'
  actorName: String,
  action: { type: String, required: true }, // e.g. SESSION_EXIT_COMPLETED, PRICING_RULE_VERSION_CREATED
  entityType: String,
  entityId: mongoose.Schema.Types.ObjectId,
  oldValue: mongoose.Schema.Types.Mixed,
  newValue: mongoose.Schema.Types.Mixed,
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
  shiftInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftInstance' },
  ipAddress: String,
  locationCheck: mongoose.Schema.Types.Mixed, // layered-check result object, §M
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true })

AuditLogSchema.index({ organizationId: 1, createdAt: -1 })
AuditLogSchema.index({ actorId: 1, createdAt: -1 })
AuditLogSchema.index({ action: 1, createdAt: -1 })
AuditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 })
AuditLogSchema.plugin(requireOrgScope)

module.exports = mongoose.model('AuditLog', AuditLogSchema)
