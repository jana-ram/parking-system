const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { createVehicleType } = require('../middleware/schemas')
const ctrl = require('../controllers/vehicleType.controller')

router.use(protect, deviceCheck)
router.get('/', ctrl.listVehicleTypes)
router.post('/', authorize('ORG_ADMIN'), validate(createVehicleType), ctrl.createVehicleType)

module.exports = router
