const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { reviewAnomaly } = require('../middleware/schemas')
const ctrl = require('../controllers/anomaly.controller')

router.use(protect, deviceCheck, authorize('MANAGER', 'ORG_ADMIN'))
router.get('/', ctrl.listAnomalies)
router.post('/:id/review', validate(reviewAnomaly), ctrl.reviewAnomaly)

module.exports = router
