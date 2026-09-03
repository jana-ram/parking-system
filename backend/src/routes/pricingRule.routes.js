const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const requireFeature = require('../middleware/requireFeature.middleware')
const validate = require('../middleware/validate.middleware')
const { createPricingRule, createPricingRuleVersion } = require('../middleware/schemas')
const ctrl = require('../controllers/pricingRule.controller')

router.use(protect, deviceCheck, requireFeature('PARKING'))
router.get('/', ctrl.listPricingRules)
router.get('/:id/preview', ctrl.previewPricing)
// §4: pricing edit is Org Admin by default; Manager access is an
// org-configurable override not yet exposed via API (Phase 4+).
router.post('/', authorize('ORG_ADMIN'), validate(createPricingRule), ctrl.createPricingRule)
router.post('/:id/versions', authorize('ORG_ADMIN'), validate(createPricingRuleVersion), ctrl.createPricingRuleVersion)

module.exports = router
