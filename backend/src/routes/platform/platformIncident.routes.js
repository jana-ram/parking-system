const express = require('express')
const router = express.Router()
const { protectPlatform } = require('../../middleware/platformAuth.middleware')
const ctrl = require('../../controllers/platform/platformIncident.controller')

router.use(protectPlatform)
router.get('/', ctrl.listIncidents)

module.exports = router
