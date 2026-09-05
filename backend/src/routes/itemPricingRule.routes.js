const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { createItemPricingRule, updateItemPricingRule } = require('../middleware/schemas')
const ctrl = require('../controllers/itemPricingRule.controller')

// Not behind a static requireFeature(moduleKey) — one collection serves both
// LUGGAGE and PARCEL, so the controller checks the target module dynamically
// (see itemPricingRule.controller.js's assertModuleEnabled).
router.use(protect, deviceCheck)
router.get('/', ctrl.listRules)
router.post('/', authorize('ORG_ADMIN'), validate(createItemPricingRule), ctrl.createRule)
router.patch('/:id', authorize('ORG_ADMIN'), validate(updateItemPricingRule), ctrl.updateRule)

module.exports = router
