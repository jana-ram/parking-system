const mongoose = require('mongoose')
const ParkingPricingRule = require('../models/ParkingPricingRule')
const PricingRuleVersion = require('../models/PricingRuleVersion')
const Location = require('../models/Location')
const Organization = require('../models/Organization')
const { calculateAmount, calculateEntryAmount } = require('../domain/pricingEngine')
const { getActiveVersion } = require('../services/pricingRule.service')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

const listPricingRules = async (req, res, next) => {
  try {
    const filter = { organizationId: req.staffUser.organizationId, status: 'ACTIVE' }
    if (req.query.locationId) filter.locationId = req.query.locationId
    if (req.query.vehicleTypeId) filter.vehicleTypeId = req.query.vehicleTypeId
    const rules = await ParkingPricingRule.find(filter).sort({ createdAt: -1 })
    res.json({ success: true, message: 'ok', data: { pricingRules: rules } })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /pricing-rules — creates the rule AND its first version together, atomically
 * (a rule with zero versions can never price anything, so there's no value in
 * letting the two exist independently even momentarily).
 */
const createPricingRule = async (req, res, next) => {
  const { locationId, vehicleTypeId, mode, name, config, effectiveFrom } = req.body
  const session = await mongoose.startSession()
  try {
    let rule, version
    await session.withTransaction(async () => {
      rule = (await ParkingPricingRule.create(
        [{ organizationId: req.staffUser.organizationId, locationId: locationId || null, vehicleTypeId, mode, name }],
        { session },
      ))[0]
      version = (await PricingRuleVersion.create(
        [{
          organizationId: req.staffUser.organizationId,
          pricingRuleId: rule._id,
          versionNumber: 1,
          config,
          effectiveFrom: effectiveFrom || new Date(),
          createdBy: req.staffUser._id,
        }],
        { session },
      ))[0]
    })

    await auditLog.record(req, {
      action: 'PRICING_RULE_VERSION_CREATED',
      entityType: 'ParkingPricingRule',
      entityId: rule._id,
      newValue: { mode, config, versionNumber: 1 },
    })

    res.status(201).json({ success: true, message: 'Pricing rule created', data: { pricingRule: rule, version } })
  } catch (err) {
    next(err)
  } finally {
    await session.endSession()
  }
}

/**
 * POST /pricing-rules/:id/versions — a pricing EDIT is always a new,
 * immutable version, never an update to an existing one (§10, §21) — every
 * ParkingSession keeps pointing at the exact version it was priced with.
 */
const createPricingRuleVersion = async (req, res, next) => {
  try {
    const { config, effectiveFrom } = req.body
    const rule = await ParkingPricingRule.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!rule) return next(createError(404, 'Pricing rule not found', null, 'NOT_FOUND'))

    const latest = await PricingRuleVersion.findOne({ pricingRuleId: rule._id }).sort({ versionNumber: -1 })
    const versionNumber = latest ? latest.versionNumber + 1 : 1

    const version = await PricingRuleVersion.create({
      organizationId: req.staffUser.organizationId,
      pricingRuleId: rule._id,
      versionNumber,
      config,
      effectiveFrom: effectiveFrom || new Date(),
      createdBy: req.staffUser._id,
    })

    await auditLog.record(req, {
      action: 'PRICING_RULE_VERSION_CREATED',
      entityType: 'ParkingPricingRule',
      entityId: rule._id,
      oldValue: latest ? { versionNumber: latest.versionNumber, config: latest.config } : undefined,
      newValue: { versionNumber, config },
    })

    res.status(201).json({ success: true, message: 'Pricing rule version created', data: { version } })
  } catch (err) {
    next(err)
  }
}

/**
 * PATCH /pricing-rules/:id — rename and/or archive only. A rate CHANGE is
 * never made here — it always goes through createPricingRuleVersion above,
 * so every ParkingSession keeps pointing at the exact immutable version it
 * was priced with. This existed as a mobile API call with no matching route
 * for a while (a real dead-end, not a design gap) — added to close it.
 */
const updatePricingRule = async (req, res, next) => {
  try {
    const rule = await ParkingPricingRule.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!rule) return next(createError(404, 'Pricing rule not found', null, 'NOT_FOUND'))

    const { name, status } = req.body
    const oldValue = { name: rule.name, status: rule.status }
    if (name !== undefined) rule.name = name
    if (status !== undefined) rule.status = status
    await rule.save()

    await auditLog.record(req, {
      action: 'PRICING_RULE_UPDATED', entityType: 'ParkingPricingRule', entityId: rule._id,
      oldValue, newValue: { name: rule.name, status: rule.status },
    })

    res.json({ success: true, message: 'Pricing rule updated', data: { pricingRule: rule } })
  } catch (err) {
    next(err)
  }
}

/**
 * GET /pricing-rules/:id/preview?entryAt=...&exitAt=... — quote calc without
 * creating a session. Uses the exact same domain functions real entry/exit
 * will use, so a preview can never diverge from what a real session would be
 * charged (§X: one calculation path, never two).
 */
const previewPricing = async (req, res, next) => {
  try {
    const rule = await ParkingPricingRule.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!rule) return next(createError(404, 'Pricing rule not found', null, 'NOT_FOUND'))

    const version = await getActiveVersion(req.staffUser.organizationId, rule._id)
    if (!version) return next(createError(422, 'This pricing rule has no version effective right now', null, 'PRICING_CONFIG_INCOMPLETE'))

    if (rule.mode === 'PAY_ON_ENTRY' || rule.mode === 'FIXED_DURATION') {
      const amountMinor = calculateEntryAmount(version.config)
      return res.json({ success: true, message: 'ok', data: { amountMinor, mode: rule.mode, versionNumber: version.versionNumber } })
    }

    const { entryAt, exitAt } = req.query
    if (!entryAt || !exitAt) return next(createError(422, 'entryAt and exitAt query params are required to preview a duration-based rule', null, 'VALIDATION_ERROR'))

    const location = rule.locationId ? await Location.findOne({ _id: rule.locationId, organizationId: req.staffUser.organizationId }) : null
    const timezone = location?.timezone || (await Organization.findById(req.staffUser.organizationId)).defaultTimezone

    const result = calculateAmount({ config: version.config, entryAt: new Date(entryAt), exitAt: new Date(exitAt), timezone })
    res.json({ success: true, message: 'ok', data: { ...result, mode: rule.mode, versionNumber: version.versionNumber } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listPricingRules, createPricingRule, createPricingRuleVersion, updatePricingRule, previewPricing }
