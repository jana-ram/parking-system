const ParkingPricingRule = require('../models/ParkingPricingRule')
const PricingRuleVersion = require('../models/PricingRuleVersion')

// The version effective "now" — newest one whose effectiveFrom has passed and
// effectiveTo (if set) hasn't. The one function that decides "which version
// applies," so a price preview and a real session entry can never disagree.
// organizationId is required (requireOrgScope, §E) — this caught a real gap
// during Phase 3's own build, the same way it did in device.controller.js
// during Phase 2: this query legitimately IS scoped, it was just missing the
// filter, not a case needing an opt-out.
async function getActiveVersion(organizationId, pricingRuleId, at = new Date()) {
  return PricingRuleVersion.findOne({
    organizationId,
    pricingRuleId,
    effectiveFrom: { $lte: at },
    $or: [{ effectiveTo: null }, { effectiveTo: { $exists: false } }, { effectiveTo: { $gte: at } }],
  }).sort({ versionNumber: -1 })
}

// A location-specific rule takes precedence over an org-wide default
// (locationId: null), §10.
async function resolveActiveRule({ organizationId, locationId, vehicleTypeId }) {
  const locationRule = await ParkingPricingRule.findOne({ organizationId, locationId, vehicleTypeId, status: 'ACTIVE' })
  const rule = locationRule || await ParkingPricingRule.findOne({ organizationId, locationId: null, vehicleTypeId, status: 'ACTIVE' })
  if (!rule) return null
  const version = await getActiveVersion(organizationId, rule._id)
  if (!version) return null
  return { rule, version }
}

module.exports = { getActiveVersion, resolveActiveRule }
