const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { startShift, closeShift, forceCloseShift, initiateHandover } = require('../middleware/schemas')
const ctrl = require('../controllers/shift.controller')

router.use(protect, deviceCheck)

// Any authenticated staff role can start/close their own shift (§14) — role
// checks for close/force-close/handover happen inside the controller since
// they depend on WHOSE shift it is, not just the caller's role.
router.get('/current', ctrl.getCurrentShift)
router.get('/open', ctrl.listOpenShiftsAtLocation)
router.post('/start', validate(startShift), ctrl.startShift)
router.post('/:id/close', validate(closeShift), ctrl.loadShift, ctrl.closeShift)
router.get('/:id/tally', ctrl.loadShift, ctrl.getTally)
router.get('/:id/tally-preview', ctrl.loadShift, ctrl.getTallyPreview)
router.post('/:id/tally/approve', authorize('MANAGER', 'ORG_ADMIN'), ctrl.loadShift, ctrl.approveTally)

// §14: Manager (own location) or Org Admin only.
router.post('/:id/force-close', authorize('MANAGER', 'ORG_ADMIN'), validate(forceCloseShift), ctrl.loadShift, ctrl.forceCloseShift)

router.post('/:id/handover/initiate', validate(initiateHandover), ctrl.loadShift, ctrl.initiateHandover)

module.exports = router
