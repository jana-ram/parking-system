const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const requireFeature = require('../middleware/requireFeature.middleware')
const validate = require('../middleware/validate.middleware')
const { createRack, updateRack, createRackSlots } = require('../middleware/schemas')
const ctrl = require('../controllers/rack.controller')

router.use(protect, deviceCheck, requireFeature('RACK'))
router.get('/', ctrl.listRacks)
router.post('/', authorize('ORG_ADMIN'), validate(createRack), ctrl.createRack)
router.patch('/:id', authorize('ORG_ADMIN'), validate(updateRack), ctrl.updateRack)
router.get('/:id/slots', ctrl.listSlots)
router.post('/:id/slots', authorize('ORG_ADMIN'), validate(createRackSlots), ctrl.createSlots)

module.exports = router
