const Location = require('../models/Location')
const AuditLog = require('../models/AuditLog')
const { haversineDistanceMeters, isPointInPolygon, createError } = require('../utils/helpers')

/**
 * locationCheck(getLocationId) — the layered check from §M. Layers: 1
 * (GPS-in-geofence — radius by default, or point-in-polygon when a Location
 * sets geofencePolygon for an irregular lot, §M), 2 (client-reported
 * mock-location flag AND Play Integrity verdict — both unconditional hard
 * blocks, §1 item 4), 3 (device bound to this location). Layer 5 (BLE/Wi-Fi
 * fingerprint) is still not built — genuinely needs hardware this project
 * doesn't have yet, deferred honestly rather than faked.
 *
 * [Phase 6 addition] every FAILURE now writes its own AuditLog row here,
 * not just successes recorded later by the controller — a rejected request
 * never reaches the controller, so without this the location-violation
 * signal the anomaly engine (§20/§R) depends on would have no data at all.
 *
 * Never reveals WHICH layer failed in the response (§M) — only the generic
 * "outside the authorized parking location" message. The full result is
 * attached to req.locationCheckResult for the controller to persist onto
 * its own success-path AuditLog.locationCheck too (§21).
 */
const LOCATION_ERROR = () => createError(403, 'You are outside the authorized parking location', null, 'LOCATION_VERIFICATION_FAILED')

// Verdicts Play Integrity can return for a compromised/untrusted device —
// the mobile client isn't wired to actually call Play Integrity yet (no
// native build exists, see SmartParkingMobile's README), so this is the
// server contract that client work will eventually satisfy, not dead code.
const FAILING_INTEGRITY_VERDICTS = new Set(['MEETS_NO_INTEGRITY', 'UNEVALUATED', 'UNRECOGNIZED_VERDICT'])

const locationCheck = (getLocationId = (req) => req.body.locationId) => async (req, res, next) => {
  const result = { layers: {} }
  const writeFailureAudit = async () => {
    try {
      await AuditLog.create({
        organizationId: req.staffUser.organizationId,
        actorId: req.staffUser._id,
        actorRole: req.staffUser.role,
        actorName: req.staffUser.name,
        action: 'LOCATION_VERIFICATION_FAILED',
        entityType: 'Location',
        entityId: result.locationId,
        deviceId: req.device?._id,
        locationId: result.locationId,
        shiftInstanceId: req.shiftInstance?._id,
        ipAddress: req.ip,
        locationCheck: result,
      })
    } catch {
      // Never let audit-logging itself block or crash the request path —
      // the location check's own pass/fail verdict already stands.
    }
  }

  try {
    const locationId = getLocationId(req)
    const check = req.body.locationCheck
    result.locationId = locationId

    if (!locationId || !check || typeof check.lat !== 'number' || typeof check.lng !== 'number') {
      result.layers.inputPresent = false
      req.locationCheckResult = result
      await writeFailureAudit()
      return next(LOCATION_ERROR())
    }

    // Layer 2 — unconditional hard blocks, regardless of org policy (§1 item 4).
    result.layers.mockDetected = check.mockDetected === true
    result.layers.playIntegrityVerdict = check.playIntegrity || null
    const failingIntegrity = check.playIntegrity && FAILING_INTEGRITY_VERDICTS.has(check.playIntegrity)
    if (result.layers.mockDetected || failingIntegrity) {
      req.locationCheckResult = result
      await writeFailureAudit()
      return next(LOCATION_ERROR())
    }

    const location = await Location.findOne({ _id: locationId, organizationId: req.staffUser.organizationId })
    if (!location) {
      result.layers.locationExists = false
      req.locationCheckResult = result
      await writeFailureAudit()
      return next(LOCATION_ERROR())
    }

    let withinGeofence
    if (location.geofencePolygon?.coordinates?.length) {
      withinGeofence = isPointInPolygon(check.lat, check.lng, location.geofencePolygon.coordinates[0])
      result.layers.geofenceType = 'POLYGON'
    } else {
      const distanceM = haversineDistanceMeters(location.geo.lat, location.geo.lng, check.lat, check.lng)
      withinGeofence = distanceM <= (location.geofenceRadiusM || 150)
      result.layers.geofenceType = 'RADIUS'
      result.layers.distanceM = Math.round(distanceM)
    }
    result.layers.withinGeofence = withinGeofence

    // Layer 3 — a device registered to a DIFFERENT location is a real signal
    // even if it happens to be GPS-inside this one's geofence right now.
    const deviceBound = !req.device.locationId || String(req.device.locationId) === String(locationId)
    result.layers.deviceBound = deviceBound

    req.locationCheckResult = result

    if (!withinGeofence || !deviceBound) {
      await writeFailureAudit()
      return next(LOCATION_ERROR())
    }
    next()
  } catch (err) {
    next(err)
  }
}

module.exports = locationCheck
