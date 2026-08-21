/**
 * ParkingArea — a sub-zone within a Location (e.g. "Basement 1", "North Lot").
 * organizationId is denormalized from Location purely so requireOrgScope (§E/§X)
 * can guard this collection the same way it guards every other tenant-scoped
 * one — §35's original design left it off, added back here since the plugin
 * needs a direct organizationId on every collection it protects.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const ParkingAreaSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true, index: true },
  name: { type: String, required: true, trim: true },
  capacity: Number,
}, { timestamps: true })

ParkingAreaSchema.plugin(requireOrgScope)

module.exports = mongoose.model('ParkingArea', ParkingAreaSchema)
