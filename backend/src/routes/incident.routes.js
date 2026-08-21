const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const ctrl = require('../controllers/incident.controller')

router.use(protect, deviceCheck, authorize('MANAGER', 'ORG_ADMIN'))
router.get('/', ctrl.listIncidents)

module.exports = router
