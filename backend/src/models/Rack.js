/**
 * Rack — a physical storage unit at a Location (§6): "Location → Branch →
 * Area/Zone → Rack → Slot". `zone` is a free-text label rather than its own
 * collection — a full Area/Zone aggregate is exactly the kind of
 * not-yet-needed hierarchy layer the platform brief itself warns against
 * designing for prematurely; add one if/when a real multi-zone location
 * needs it. `allowedItemTypes` empty means "no restriction at the rack
 * level" — individual RackSlots (RackSlot.js) can still narrow further.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')
const { RACK_ITEM_TYPES } = require('../config/rackItemTypes')

const RACK_STATUSES = ['ACTIVE', 'MAINTENANCE', 'BLOCKED']

const RackSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true, index: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, trim: true },
  zone: { type: String, trim: true },
  allowedItemTypes: { type: [String], enum: RACK_ITEM_TYPES, default: [] },
  status: { type: String, enum: RACK_STATUSES, default: 'ACTIVE' },
}, { timestamps: true })

RackSchema.index({ locationId: 1, code: 1 }, { unique: true })
RackSchema.statics.STATUSES = RACK_STATUSES
RackSchema.plugin(requireOrgScope)

module.exports = mongoose.model('Rack', RackSchema)
