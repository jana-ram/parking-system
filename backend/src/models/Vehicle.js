/**
 * Vehicle — dedups by normalized plate per organization (helpers.normalizeVehicleNumber
 * must be applied before every read/write here). Lets a vehicle accumulate
 * unlimited historical sessions while §1 item 13's partial-unique-index rule
 * (on ParkingSession) still guarantees only one non-terminal session at a time.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const VehicleSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  vehicleNumber: { type: String, required: true, uppercase: true, trim: true },
  vehicleTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleType' },
  firstSeenAt: { type: Date, default: Date.now },
}, { timestamps: true })

VehicleSchema.index({ organizationId: 1, vehicleNumber: 1 }, { unique: true })
VehicleSchema.plugin(requireOrgScope)

module.exports = mongoose.model('Vehicle', VehicleSchema)
