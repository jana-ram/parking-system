const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const requireFeature = require('../middleware/requireFeature.middleware')
const validate = require('../middleware/validate.middleware')
const { createVehicleType, updateVehicleType } = require('../middleware/schemas')
const ctrl = require('../controllers/vehicleType.controller')

router.use(protect, deviceCheck, requireFeature('PARKING'))
router.get('/', ctrl.listVehicleTypes)
router.post('/', authorize('ORG_ADMIN'), validate(createVehicleType), ctrl.createVehicleType)
router.patch('/:id', authorize('ORG_ADMIN'), validate(updateVehicleType), ctrl.updateVehicleType)

module.exports = router
