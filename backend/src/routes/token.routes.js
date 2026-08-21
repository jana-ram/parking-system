const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { provisionTokenBatch, reinstateToken, markTokenStatus } = require('../middleware/schemas')
const ctrl = require('../controllers/token.controller')

router.use(protect, deviceCheck)
router.get('/', ctrl.listTokens)
router.get('/summary', ctrl.tokenSummary)
router.post('/batches', authorize('ORG_ADMIN'), validate(provisionTokenBatch), ctrl.provisionBatch)
// §6: reinstate is Manager+ (not Staff) — the one place a bare token status
// flip is allowed, and only with an explicit reason.
router.post('/:id/reinstate', authorize('MANAGER', 'ORG_ADMIN'), validate(reinstateToken), ctrl.reinstateToken)
router.post('/:id/status', authorize('MANAGER', 'ORG_ADMIN'), validate(markTokenStatus), ctrl.markTokenStatus)

module.exports = router
