const express = require('express')
const router = express.Router()
const { protect } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const ctrl = require('../controllers/handover.controller')

router.use(protect, deviceCheck)
router.get('/:id', ctrl.getHandover)
// §18: only the incoming staff member can accept — enforced in the
// controller/service (needs to compare against the target shift's staffId,
// not just a role), not a role-based route guard.
router.post('/:id/accept', ctrl.acceptHandover)

module.exports = router
