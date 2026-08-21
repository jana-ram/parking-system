const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const VehicleTypeSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  code: { type: String, required: true, uppercase: true, trim: true }, // 'BIKE','CAR','SUV','TRUCK','EV'...
  name: { type: String, required: true, trim: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

VehicleTypeSchema.index({ organizationId: 1, code: 1 }, { unique: true })
VehicleTypeSchema.plugin(requireOrgScope)

module.exports = mongoose.model('VehicleType', VehicleTypeSchema)
