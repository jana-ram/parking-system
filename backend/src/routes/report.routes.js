const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const ctrl = require('../controllers/report.controller')

// §36: Manager+ only, same RBAC tier as audit logs/incidents — reports
// aggregate revenue and shift-level operational data, not something Staff
// needs day-to-day.
router.use(protect, deviceCheck, authorize('MANAGER', 'ORG_ADMIN'))
router.get('/summary', ctrl.getSummary)
router.get('/staff-collection', ctrl.getStaffCollection)

module.exports = router
