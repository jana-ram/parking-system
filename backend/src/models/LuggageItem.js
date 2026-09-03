/**
 * LuggageItem — one physical piece under a LuggageOrder (§8: "Luggage ID,
 * ... Item description, Quantity, Rack/slot ... Status"). `rackSlotId` is
 * denormalized here for quick lookup; the RackSlot itself is the source of
 * truth for occupancy (assigned/released via services/rackSlot.service.js,
 * the same code path rack.controller.js uses — see luggage.controller.js).
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const ITEM_STATUSES = ['CHECKED_IN', 'PICKED_UP', 'CANCELLED']

const LuggageItemSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'LuggageOrder', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true, index: true },
  itemCode: { type: String, required: true },
  description: { type: String, required: true, trim: true },
  quantity: { type: Number, default: 1, min: 1 },
  rackSlotId: { type: mongoose.Schema.Types.ObjectId, ref: 'RackSlot', default: null },
  status: { type: String, enum: ITEM_STATUSES, default: 'CHECKED_IN' },
  pickedUpAt: { type: Date, default: null },
}, { timestamps: true })

LuggageItemSchema.index({ organizationId: 1, itemCode: 1 }, { unique: true })
LuggageItemSchema.statics.STATUSES = ITEM_STATUSES
LuggageItemSchema.plugin(requireOrgScope)

module.exports = mongoose.model('LuggageItem', LuggageItemSchema)
