const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const ctrl = require('../controllers/audit.controller')

// §O: View audit logs — Manager+/Org Admin only, not Staff.
router.use(protect, deviceCheck, authorize('MANAGER', 'ORG_ADMIN'))
router.get('/', ctrl.listAuditLogs)

module.exports = router
