/**
 * ParkingPricingRule — modelled after the existing ride-hailing PricingRule.js's
 * authoring ergonomics (top-level enum consts, admin-editable via a similar
 * UI pattern), but a distinct collection for a distinct product. See
 * PricingRuleVersion.js for where the actual tier/rate config lives — this
 * document is just the identity + mode of a rule; versions are immutable.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const PRICING_MODES = ['PAY_ON_EXIT', 'PAY_ON_ENTRY', 'FIXED_DURATION', 'HYBRID']
const RULE_STATUSES = ['ACTIVE', 'ARCHIVED']

const ParkingPricingRuleSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null }, // null = org-wide default
  vehicleTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleType', required: true },
  mode: { type: String, enum: PRICING_MODES, required: true },
  name: { type: String, required: true, trim: true },
  status: { type: String, enum: RULE_STATUSES, default: 'ACTIVE' },
}, { timestamps: true })

ParkingPricingRuleSchema.statics.MODES = PRICING_MODES
ParkingPricingRuleSchema.statics.STATUSES = RULE_STATUSES
ParkingPricingRuleSchema.plugin(requireOrgScope)

module.exports = mongoose.model('ParkingPricingRule', ParkingPricingRuleSchema)
