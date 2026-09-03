const express = require('express')
const router = express.Router()
const { protect, authorizeOrPermission } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const requireFeature = require('../middleware/requireFeature.middleware')
const validate = require('../middleware/validate.middleware')
const { createPricingRule, createPricingRuleVersion } = require('../middleware/schemas')
const ctrl = require('../controllers/pricingRule.controller')

router.use(protect, deviceCheck, requireFeature('PARKING'))
router.get('/', ctrl.listPricingRules)
router.get('/:id/preview', ctrl.previewPricing)
// §4/§3/§O: pricing edit is Org Admin by default; a Manager (or, via a
// permissionOverrides GRANT set through PATCH /staff/:id, even a Staff
// account) can be given the 'pricing.edit' permission as a named exception —
// the "Supervisor can edit pricing but isn't a full Org Admin" case §3 asks
// for, without adding a new hardcoded role.
router.post('/', authorizeOrPermission(['ORG_ADMIN'], 'pricing.edit'), validate(createPricingRule), ctrl.createPricingRule)
router.post('/:id/versions', authorizeOrPermission(['ORG_ADMIN'], 'pricing.edit'), validate(createPricingRuleVersion), ctrl.createPricingRuleVersion)

module.exports = router
