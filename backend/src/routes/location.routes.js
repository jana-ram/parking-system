const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { createLocation, updateLocation } = require('../middleware/schemas')
const ctrl = require('../controllers/location.controller')

router.use(protect, deviceCheck)
router.get('/', ctrl.listLocations)
router.get('/:id', ctrl.getLocation)
router.post('/', authorize('ORG_ADMIN'), validate(createLocation), ctrl.createLocation)
router.patch('/:id', authorize('ORG_ADMIN'), validate(updateLocation), ctrl.updateLocation)

module.exports = router
