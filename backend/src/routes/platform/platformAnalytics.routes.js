const express = require('express')
const router = express.Router()
const { protectPlatform } = require('../../middleware/platformAuth.middleware')
const ctrl = require('../../controllers/platform/platformAnalytics.controller')

router.use(protectPlatform)
router.get('/overview', ctrl.getOverview)

module.exports = router
