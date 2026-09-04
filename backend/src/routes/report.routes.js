const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const requireFeature = require('../middleware/requireFeature.middleware')
const ctrl = require('../controllers/report.controller')

// §36: Manager+ only, same RBAC tier as audit logs/incidents — reports
// aggregate revenue and shift-level operational data, not something Staff
// needs day-to-day.
router.use(protect, deviceCheck, requireFeature('REPORTS'), authorize('MANAGER', 'ORG_ADMIN'))
router.get('/summary', ctrl.getSummary)
router.get('/summary/export', ctrl.exportSummaryCsv)
router.get('/staff-collection', ctrl.getStaffCollection)
router.get('/staff-collection/export', ctrl.exportStaffCollectionCsv)
router.get('/shifts/:id/transactions', ctrl.getShiftTransactions)
router.get('/shifts/:id/transactions/export', ctrl.exportShiftTransactionsCsv)
router.get('/corrections', ctrl.getCorrections)
router.get('/corrections/export', ctrl.exportCorrectionsCsv)

module.exports = router
