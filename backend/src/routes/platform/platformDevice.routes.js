const express = require('express')
const router = express.Router()
const { protectPlatform } = require('../../middleware/platformAuth.middleware')
const validate = require('../../middleware/validate.middleware')
const { deactivateDevice } = require('../../middleware/schemas')
const ctrl = require('../../controllers/platform/platformDevice.controller')

router.use(protectPlatform)
router.get('/', ctrl.listDevices)
router.post('/:id/deactivate', validate(deactivateDevice), ctrl.deactivateDevice)

module.exports = router
