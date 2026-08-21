const express = require('express')
const router = express.Router()
const { protectPlatform } = require('../../middleware/platformAuth.middleware')
const ctrl = require('../../controllers/platform/platformLocation.controller')

router.use(protectPlatform)
router.get('/', ctrl.listLocations)

module.exports = router
