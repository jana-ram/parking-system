/**
 * ParcelItem — one physical parcel under a ParcelOrder (§9: "Parcel type,
 * Quantity, Rack ... Collected/Returned/Overdue status"). Same rackSlotId
 * denormalization convention as LuggageItem.js.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const ITEM_STATUSES = ['RECEIVED', 'COLLECTED', 'CANCELLED']

const ParcelItemSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParcelOrder', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true, index: true },
  itemCode: { type: String, required: true },
  parcelType: { type: String, trim: true },
  description: { type: String, trim: true },
  quantity: { type: Number, default: 1, min: 1 },
  rackSlotId: { type: mongoose.Schema.Types.ObjectId, ref: 'RackSlot', default: null },
  status: { type: String, enum: ITEM_STATUSES, default: 'RECEIVED' },
  collectedAt: { type: Date, default: null },
}, { timestamps: true })

ParcelItemSchema.index({ organizationId: 1, itemCode: 1 }, { unique: true })
ParcelItemSchema.statics.STATUSES = ITEM_STATUSES
ParcelItemSchema.plugin(requireOrgScope)

module.exports = mongoose.model('ParcelItem', ParcelItemSchema)
