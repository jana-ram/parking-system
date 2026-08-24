/**
 * Location — one physical parking site belonging to an Organization. Carries
 * the geofence used for layered location verification (§M) and the
 * timezone/currency a session at this location bills in.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const LOCATION_STATUSES = ['ACTIVE', 'INACTIVE']

const LocationSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  countryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: true },
  name: { type: String, required: true, trim: true },
  address: String,
  geo: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  geofenceRadiusM: { type: Number, default: 150 },
  // GeoJSON polygon, optional override for irregular lots (§M) — not required
  geofencePolygon: {
    type: { type: String, enum: ['Polygon'] },
    coordinates: [[[Number]]],
  },
  timezone: { type: String, required: true },
  currency: { type: String, required: true, uppercase: true },
  status: { type: String, enum: LOCATION_STATUSES, default: 'ACTIVE' },
  // Per-location operating-policy toggles (distinct from pricing math, which
  // stays in PricingRuleVersion.config) — default off, turned on via
  // PATCH /locations/:id once a location exists.
  features: {
    exitDiscount: { enabled: { type: Boolean, default: false } },
    fixedEntryNoExit: { enabled: { type: Boolean, default: false } },
    slotAssignment: { enabled: { type: Boolean, default: false } },
  },
}, { timestamps: true })

LocationSchema.index({ geofencePolygon: '2dsphere' }, { sparse: true })
LocationSchema.statics.STATUSES = LOCATION_STATUSES
LocationSchema.plugin(requireOrgScope)

module.exports = mongoose.model('Location', LocationSchema)
