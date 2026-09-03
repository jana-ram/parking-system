const express = require('express')
const router = express.Router()
const { protect } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const requireFeature = require('../middleware/requireFeature.middleware')
const shiftCheck = require('../middleware/shiftCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { assignLuggageItemRack, releaseLuggageItemRack } = require('../middleware/schemas')
const ctrl = require('../controllers/luggage.controller')

router.use(protect, deviceCheck, requireFeature('LUGGAGE'), shiftCheck)
router.post('/:id/assign-rack', validate(assignLuggageItemRack), ctrl.assignItemRack)
router.post('/:id/release-rack', validate(releaseLuggageItemRack), ctrl.releaseItemRack)

module.exports = router
