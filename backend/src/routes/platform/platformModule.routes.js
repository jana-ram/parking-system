const express = require('express')
const router = express.Router()
const { protectPlatform } = require('../../middleware/platformAuth.middleware')
const ctrl = require('../../controllers/platform/platformModule.controller')

router.use(protectPlatform)
router.get('/', ctrl.listModules)

module.exports = router
