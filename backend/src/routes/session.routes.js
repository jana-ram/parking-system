const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const requireFeature = require('../middleware/requireFeature.middleware')
const shiftCheck = require('../middleware/shiftCheck.middleware')
const locationCheck = require('../middleware/locationCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { sessionEntry, sessionExitRequest, sessionPayment, sessionCancel } = require('../middleware/schemas')
const ctrl = require('../controllers/session.controller')

router.use(protect, deviceCheck, requireFeature('PARKING'))

// Read-only — no active shift required to search/browse (§4).
router.get('/active', ctrl.listActiveSessions)
router.get('/search', ctrl.searchSessions)
router.get('/by-token/:tokenCode', ctrl.findSessionByTokenCode)

// Ordered cheapest/clearest-rejection-first: validate the shape of what was
// sent, THEN shift (is this device even on the clock), THEN location (the
// most expensive and most sensitive check, §M) — and validate() must run
// before locationCheck specifically, since locationCheck reads req.body
// fields directly and needs them already type-checked, not raw client input.
router.post(
  '/entry',
  validate(sessionEntry),
  shiftCheck,
  locationCheck((req) => req.body.locationId),
  ctrl.enterVehicle,
)

router.post(
  '/:id/exit/request',
  validate(sessionExitRequest),
  shiftCheck,
  ctrl.loadSession,
  locationCheck((req) => req.session.locationId),
  ctrl.requestExit,
)

// Payment is a continuation of an already location-verified entry/exit —
// not independently location-checked in this phase (Phase 3 scope note).
router.post('/:id/payment', validate(sessionPayment), shiftCheck, ctrl.loadSession, ctrl.recordPayment)

// §12/§O: Manager+ only — role enforcement also happens inside
// sessionStateMachine.assertTransition itself, not just this route guard.
// Deliberately NOT behind shiftCheck: this is a Manager-issued administrative
// override (like force-close, shift.routes.js), not a routine floor
// operation — requiring the CANCELLING manager to also have their own open
// shift at this location would be an arbitrary extra constraint the role
// gate + mandatory reason + audit trail already cover.
router.post('/:id/cancel', validate(sessionCancel), authorize('MANAGER', 'ORG_ADMIN'), ctrl.loadSession, ctrl.cancelSession)

module.exports = router
