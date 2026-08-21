const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { registerDevice, deactivateDevice } = require('../middleware/schemas')
const ctrl = require('../controllers/device.controller')

router.use(protect)
// register is intentionally BEFORE deviceCheck is required anywhere — see
// device.controller.js's header comment (bootstrapping problem, §N).
router.post('/register', authorize('ORG_ADMIN'), validate(registerDevice), ctrl.registerDevice)

router.use(deviceCheck)
router.get('/', authorize('MANAGER', 'ORG_ADMIN'), ctrl.listDevices)
router.post('/:id/deactivate', authorize('ORG_ADMIN'), validate(deactivateDevice), ctrl.deactivateDevice)

module.exports = router
