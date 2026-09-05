/**
 * ItemPricingRule — Luggage/Parcel's pricing configuration (§2 of the
 * platform brief: "add separate pricing configuration for Luggage and
 * Parcel... support hourly/daily/multiple-day pricing"). Deliberately a
 * simpler shape than ParkingPricingRule/PricingRuleVersion: one mutable
 * "current rate" row per rule, no immutable version history — a rate
 * change here updates the row directly (same CRUD depth as VehicleType).
 * A past order's charge stays correct regardless, because the resolved
 * rate/unit/maxDays are snapshotted onto the order itself at check-in time
 * (LuggageOrder/ParcelOrder's ratePerDayMinor/pricingUnit/maxDays), the same
 * way ratePerDayMinor already worked before this model existed — only the
 * rate used for the NEXT order changes when this rule is edited.
 *
 * One collection serves both modules (a `module` discriminator) rather than
 * two near-identical models, since Luggage and Parcel pricing are
 * structurally identical (see luggagePricing.js, shared by both services).
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const MODULES = ['LUGGAGE', 'PARCEL']
const UNITS = ['HOUR', 'DAY']
const STATUSES = ['ACTIVE', 'ARCHIVED']

const ItemPricingRuleSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  module: { type: String, enum: MODULES, required: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null }, // null = org-wide default
  name: { type: String, required: true, trim: true },
  unit: { type: String, enum: UNITS, required: true },
  rateMinor: { type: Number, required: true, min: 0 },
  // Only meaningful for unit:'HOUR' — caps total charge at maxDays*24 hours
  // worth, so an hourly rate never runs away on a multi-day stay. Optional;
  // null means uncapped.
  maxDays: { type: Number, min: 1, default: null },
  status: { type: String, enum: STATUSES, default: 'ACTIVE' },
}, { timestamps: true })

ItemPricingRuleSchema.index({ organizationId: 1, module: 1, locationId: 1 })
ItemPricingRuleSchema.statics.MODULES = MODULES
ItemPricingRuleSchema.statics.UNITS = UNITS
ItemPricingRuleSchema.statics.STATUSES = STATUSES
ItemPricingRuleSchema.plugin(requireOrgScope)

module.exports = mongoose.model('ItemPricingRule', ItemPricingRuleSchema)
