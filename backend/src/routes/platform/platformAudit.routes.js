const express = require('express')
const router = express.Router()
const { protectPlatform } = require('../../middleware/platformAuth.middleware')
const ctrl = require('../../controllers/platform/platformAudit.controller')

router.use(protectPlatform)
router.get('/', ctrl.listAuditLogs)

module.exports = router
