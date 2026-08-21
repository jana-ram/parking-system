const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const SLOT_STATUSES = ['AVAILABLE', 'OCCUPIED', 'BLOCKED']

const ParkingSlotSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true }, // denormalized, see ParkingArea.js
  parkingAreaId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParkingArea', required: true, index: true },
  slotNumber: { type: String, required: true, trim: true },
  vehicleTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleType' },
  status: { type: String, enum: SLOT_STATUSES, default: 'AVAILABLE' },
}, { timestamps: true })

ParkingSlotSchema.index({ parkingAreaId: 1, slotNumber: 1 }, { unique: true })
ParkingSlotSchema.statics.STATUSES = SLOT_STATUSES
ParkingSlotSchema.plugin(requireOrgScope)

module.exports = mongoose.model('ParkingSlot', ParkingSlotSchema)
