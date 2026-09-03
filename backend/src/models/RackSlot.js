/**
 * RackSlot — the actual assignable unit within a Rack (§6/§7). Deliberately
 * one item per slot (no `capacityUnits`) for this first pass — a slot that
 * holds multiple items at once is a real future need but not one anything
 * today exercises, and it would complicate assign/release atomicity for no
 * current benefit; add it if a concrete multi-item-per-slot case shows up.
 *
 * `currentItemRef` is a plain String, not a Mongoose ref, on purpose: Rack
 * Management (this phase) ships before Luggage/Parcel have their own
 * collections, so a slot must be assignable to *something* today (tested via
 * an arbitrary itemType/itemRef pair) without forward-referencing models
 * that don't exist yet. When LuggageItem/ParcelItem land, they read this
 * field back as their own ObjectId string — no migration needed here.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')
const { RACK_ITEM_TYPES } = require('../config/rackItemTypes')

const SLOT_STATUSES = ['AVAILABLE', 'OCCUPIED', 'RESERVED', 'BLOCKED', 'MAINTENANCE']
const SECURITY_LEVELS = ['STANDARD', 'HIGH']

const RackSlotSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  rackId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rack', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true, index: true }, // denormalized from Rack, same convention as ParkingSlot/ParkingArea
  slotCode: { type: String, required: true, trim: true, uppercase: true },
  allowedItemTypes: { type: [String], enum: RACK_ITEM_TYPES, default: [] }, // empty = inherits no restriction beyond the rack's own
  maxWeightKg: Number,
  dimensions: {
    _id: false,
    lengthCm: Number,
    widthCm: Number,
    heightCm: Number,
  },
  securityLevel: { type: String, enum: SECURITY_LEVELS, default: 'STANDARD' },
  status: { type: String, enum: SLOT_STATUSES, default: 'AVAILABLE' },
  currentItemType: { type: String, enum: RACK_ITEM_TYPES, default: null },
  currentItemRef: { type: String, default: null },
  occupiedAt: { type: Date, default: null },
}, { timestamps: true })

RackSlotSchema.index({ rackId: 1, slotCode: 1 }, { unique: true })
RackSlotSchema.statics.STATUSES = SLOT_STATUSES
RackSlotSchema.statics.SECURITY_LEVELS = SECURITY_LEVELS
RackSlotSchema.plugin(requireOrgScope)

module.exports = mongoose.model('RackSlot', RackSlotSchema)
