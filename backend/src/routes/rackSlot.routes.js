const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const requireFeature = require('../middleware/requireFeature.middleware')
const shiftCheck = require('../middleware/shiftCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { assignRackSlot, releaseRackSlot, updateRackSlotStatus } = require('../middleware/schemas')
const ctrl = require('../controllers/rack.controller')

router.use(protect, deviceCheck, requireFeature('RACK'))
router.get('/suggest', ctrl.suggestRackSlot)
// Assign/release are operational, counter-side writes — bound to an active
// shift, like session entry/exit. Manual status overrides (maintenance/
// blocked/reserved) are Manager+ administrative actions, no shift required —
// same split token.routes.js uses between entry/exit and reinstate/status.
router.post('/:id/assign', shiftCheck, validate(assignRackSlot), ctrl.assignSlot)
router.post('/:id/release', shiftCheck, validate(releaseRackSlot), ctrl.releaseSlot)
router.patch('/:id/status', authorize('MANAGER', 'ORG_ADMIN'), validate(updateRackSlotStatus), ctrl.updateSlotStatus)

module.exports = router
