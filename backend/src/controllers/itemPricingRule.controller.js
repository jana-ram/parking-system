const ItemPricingRule = require('../models/ItemPricingRule')
const Organization = require('../models/Organization')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

// One collection serves both LUGGAGE and PARCEL (module discriminator), so
// this can't sit behind a single static requireFeature(moduleKey) the way
// most routers do — check dynamically against whichever module the request
// actually targets, same 403/FEATURE_DISABLED shape requireFeature.middleware.js uses.
async function assertModuleEnabled(organizationId, moduleKey) {
  const org = await Organization.findById(organizationId).select('modules')
  if (!org?.modules?.[moduleKey]) {
    throw createError(403, `The '${moduleKey}' module is not enabled for your organization`, null, 'FEATURE_DISABLED')
  }
}

// GET /item-pricing-rules?module=LUGGAGE&locationId= — only returns rules
// for modules the org actually has enabled, same "don't show what you can't
// use" principle as everywhere else feature-gating shows up.
const listRules = async (req, res, next) => {
  try {
    const organizationId = req.staffUser.organizationId
    const org = await Organization.findById(organizationId).select('modules')
    const filter = { organizationId, status: 'ACTIVE' }
    if (req.query.module) filter.module = req.query.module
    if (req.query.locationId) filter.locationId = req.query.locationId

    const rules = (await ItemPricingRule.find(filter).sort({ createdAt: -1 }))
      .filter((r) => org?.modules?.[r.module])
    res.json({ success: true, message: 'ok', data: { rules } })
  } catch (err) {
    next(err)
  }
}

const createRule = async (req, res, next) => {
  try {
    const { module, locationId, name, unit, rateMinor, maxDays } = req.body
    await assertModuleEnabled(req.staffUser.organizationId, module)

    const rule = await ItemPricingRule.create({
      organizationId: req.staffUser.organizationId, module, locationId: locationId || null, name, unit, rateMinor, maxDays: maxDays ?? null,
    })

    await auditLog.record(req, { action: 'ITEM_PRICING_RULE_CREATED', entityType: 'ItemPricingRule', entityId: rule._id, newValue: { module, unit, rateMinor, maxDays } })

    res.status(201).json({ success: true, message: 'Pricing rule created', data: { rule } })
  } catch (err) {
    next(err)
  }
}

// PATCH /item-pricing-rules/:id — rename/reprice/archive, in place (no
// version history — see ItemPricingRule.js's header for why that's fine
// here: the rate is snapshotted onto each order at check-in, so editing
// this rule never retroactively changes an existing order's charge).
const updateRule = async (req, res, next) => {
  try {
    const rule = await ItemPricingRule.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!rule) return next(createError(404, 'Pricing rule not found', null, 'NOT_FOUND'))

    const { name, rateMinor, maxDays, status } = req.body
    const oldValue = { name: rule.name, rateMinor: rule.rateMinor, maxDays: rule.maxDays, status: rule.status }
    if (name !== undefined) rule.name = name
    if (rateMinor !== undefined) rule.rateMinor = rateMinor
    if (maxDays !== undefined) rule.maxDays = maxDays
    if (status !== undefined) rule.status = status
    await rule.save()

    await auditLog.record(req, {
      action: 'ITEM_PRICING_RULE_UPDATED', entityType: 'ItemPricingRule', entityId: rule._id,
      oldValue, newValue: { name: rule.name, rateMinor: rule.rateMinor, maxDays: rule.maxDays, status: rule.status },
    })

    res.json({ success: true, message: 'Pricing rule updated', data: { rule } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listRules, createRule, updateRule }
