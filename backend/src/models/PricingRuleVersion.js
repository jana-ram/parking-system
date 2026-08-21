/**
 * PricingRuleVersion — IMMUTABLE once referenced by any ParkingSession (§10,
 * §F). No update route exists for this collection anywhere in the API, only
 * insert — enforced by convention here and by service-layer refusal in
 * pricingRule.controller.js. `config` shape is consumed by
 * src/domain/pricingEngine.js — see that file for the authoritative contract.
 *
 * For PAY_ON_EXIT/HYBRID (duration known only at exit, uses calculateAmount()):
 * config = {
 *   tierType: 'SLAB' | 'HOURLY',
 *   // SLAB: cumulative duration bands, e.g. "0-2h=Rs20, 2-5h=Rs40..."
 *   slabs: [{ uptoMinutes: Number, amountMinor: Number }],   // sorted ascending, last band's uptoMinutes may be null (open-ended)
 *   // HOURLY: first-hour + additional-hourly rate, e.g. "first hour Rs30, +Rs20/hr after"
 *   firstHourMinor: Number,
 *   additionalHourMinor: Number,
 *   gracePeriodMinutes: Number,       // free window before any charge applies, e.g. 10
 *   dailyMaxMinor: Number,            // resets at location-local midnight, §1 item 10
 *   weekendMultiplier: Number,        // default 1
 *   holidayMultiplier: Number,        // default 1
 *   overnight: { enabled: Boolean, cutoffHour: Number, flatMinor: Number }, // optional
 * }
 *
 * For PAY_ON_ENTRY/FIXED_DURATION (amount must be known at entry, uses
 * calculateEntryAmount() — see that function's header for why this is a
 * separate path, and its documented Phase 3 scope limit on overstay handling):
 * config = { flatAmountMinor: Number }
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const PricingRuleVersionSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  pricingRuleId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParkingPricingRule', required: true, index: true },
  versionNumber: { type: Number, required: true },
  config: { type: mongoose.Schema.Types.Mixed, required: true },
  effectiveFrom: { type: Date, required: true },
  effectiveTo: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
}, { timestamps: true })

PricingRuleVersionSchema.index({ pricingRuleId: 1, versionNumber: 1 }, { unique: true })
PricingRuleVersionSchema.plugin(requireOrgScope)

module.exports = mongoose.model('PricingRuleVersion', PricingRuleVersionSchema)
