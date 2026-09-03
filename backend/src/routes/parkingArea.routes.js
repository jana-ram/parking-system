const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const requireFeature = require('../middleware/requireFeature.middleware')
const validate = require('../middleware/validate.middleware')
const { createParkingArea, createSlots } = require('../middleware/schemas')
const ctrl = require('../controllers/parkingArea.controller')

router.use(protect, deviceCheck, requireFeature('PARKING'))
router.get('/', ctrl.listParkingAreas)
router.post('/', authorize('ORG_ADMIN'), validate(createParkingArea), ctrl.createParkingArea)
router.get('/:id/slots', ctrl.listSlots)
router.post('/:id/slots', authorize('ORG_ADMIN'), validate(createSlots), ctrl.createSlots)

module.exports = router
