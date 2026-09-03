const express = require('express')
const router = express.Router()
const { protect } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const ctrl = require('../controllers/notification.controller')

// Not behind requireFeature — notifications are cross-cutting (shift/anomaly
// alerts fire regardless of which optional modules an org has enabled), same
// tier as /audit-logs and /anomalies.
router.use(protect, deviceCheck)
router.get('/', ctrl.listMine)
router.patch('/:id/read', ctrl.markRead)

module.exports = router
