const createError = (statusCode, message, details, code) => {
  const err = new Error(message)
  err.statusCode = statusCode
  if (details) err.details = details
  if (code) err.code = code
  return err
}

// Normalizes vehicle plate input so "tn 69 ab 1234", "TN69AB1234", " tn69ab1234 "
// all resolve to the same Vehicle document (§E's unique index on
// {organizationId, vehicleNumber} depends on callers normalizing before write/read).
const normalizeVehicleNumber = (raw) =>
  (raw || '').toUpperCase().replace(/\s+/g, '').trim()

// Escapes regex metacharacters in user-supplied search input before it's
// used to build a partial-match RegExp (session.controller.js's search) —
// without this, a query containing e.g. "(", "." or "+" either throws or
// silently matches more/less than the literal characters the user typed.
const escapeRegex = (raw) => (raw || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const haversineDistanceMeters = (lat1, lng1, lat2, lng2) => {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Standard ray-casting point-in-polygon test. `polygonCoords` is a GeoJSON
// Polygon's outer ring: [[lng,lat], [lng,lat], ..., first point repeated to
// close] (§M's optional geofencePolygon override for irregular lots — used
// instead of the simple radius check when a Location sets one).
const isPointInPolygon = (lat, lng, polygonCoords) => {
  let inside = false
  for (let i = 0, j = polygonCoords.length - 1; i < polygonCoords.length; j = i++) {
    const [lngI, latI] = polygonCoords[i]
    const [lngJ, latJ] = polygonCoords[j]
    const intersects = (latI > lat) !== (latJ > lat) &&
      lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI
    if (intersects) inside = !inside
  }
  return inside
}

module.exports = { createError, normalizeVehicleNumber, escapeRegex, haversineDistanceMeters, isPointInPolygon }
