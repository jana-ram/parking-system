/**
 * correction.service.js — the generic "manual override, always recorded"
 * primitive (§12/§15 of the platform brief): "Never silently overwrite the
 * calculated amount." Every caller (session/luggage/parcel override-amount
 * actions) funnels through here so the Correction ledger stays the single,
 * consistent place this history lives — old value, new value, reason, who,
 * when — rather than each domain inventing its own ad-hoc audit shape.
 *
 * There is no separate two-person "approval" workflow: the action is
 * Manager+-only at the route layer (same tier as session cancel/discount),
 * so the actor performing the override IS the approval — matching how
 * every other single-actor sensitive action in this codebase already works
 * (e.g. shift tally mismatch approval). `approvedBy` is stamped as the same
 * actor for that reason, not left null.
 */
const Correction = require('../models/Correction')
const auditLog = require('./auditLog.service')

async function applyCorrection({ organizationId, entityType, entityId, field, oldValue, newValue, reason, staffUser, deviceId, locationId, shiftInstanceId }) {
  const correction = await Correction.create({
    organizationId, entityType, entityId, field, oldValue, newValue, reason,
    requestedBy: staffUser._id, approvedBy: staffUser._id,
  })

  await auditLog.recordSystem({
    organizationId, actorId: staffUser._id, actorRole: staffUser.role, actorName: staffUser.name,
    action: 'CORRECTION_APPLIED', entityType, entityId,
    oldValue: { [field]: oldValue }, newValue: { [field]: newValue, reason },
    deviceId, locationId, shiftInstanceId,
  })

  return correction
}

module.exports = { applyCorrection }
