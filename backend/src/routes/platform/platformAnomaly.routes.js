const express = require('express')
const router = express.Router()
const { protectPlatform } = require('../../middleware/platformAuth.middleware')
const ctrl = require('../../controllers/platform/platformAnomaly.controller')

router.use(protectPlatform)
router.get('/', ctrl.listAnomalies)

module.exports = router
