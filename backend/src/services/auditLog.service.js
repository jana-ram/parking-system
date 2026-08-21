const AuditLog = require('../models/AuditLog')

/**
 * recordSystem({...}) — the actual writer, taking every field explicitly.
 * Used directly by service-layer code (session.service.js, etc.) that has no
 * `req` to pull from — those run business logic decoupled from Express on
 * purpose, so they stay unit-testable without a mocked request object.
 */
async function recordSystem({ organizationId, actorId, actorRole, actorName, action, entityType, entityId, oldValue, newValue, deviceId, locationId, shiftInstanceId, ipAddress, metadata }) {
  return AuditLog.create({
    organizationId, actorId, actorRole, actorName, action, entityType, entityId,
    oldValue, newValue, deviceId, locationId, shiftInstanceId, ipAddress, metadata,
  })
}

/**
 * record(req, {...}) — extends nammaraidu-web/backend's auditLog.service.js
 * pattern with the fields this multi-tenant, device/location/shift-bound
 * product needs (§21), pulled straight off the request object so a
 * controller doesn't have to remember to wire them individually.
 */
async function record(req, { action, entityType, entityId, oldValue, newValue, metadata, locationId, shiftInstanceId }) {
  return recordSystem({
    organizationId: req.staffUser.organizationId,
    actorId: req.staffUser._id,
    actorRole: req.staffUser.role,
    actorName: req.staffUser.name,
    action,
    entityType,
    entityId,
    oldValue,
    newValue,
    deviceId: req.device?._id,
    locationId,
    shiftInstanceId,
    ipAddress: req.ip,
    metadata,
  })
}

module.exports = { record, recordSystem }
