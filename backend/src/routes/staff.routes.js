const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { createStaff, updateStaff, updateOwnStaff } = require('../middleware/schemas')
const ctrl = require('../controllers/staff.controller')

router.use(protect, deviceCheck)
// Self-service profile (any role) — registered before the /:id routes below,
// since Express matches path literals in registration order and "me" would
// otherwise be swallowed as an :id param by the ORG_ADMIN-only routes.
router.get('/me', ctrl.getMe)
router.patch('/me', validate(updateOwnStaff), ctrl.updateMe)
// Any role — the "Call Admin" button needs this from a plain Staff account too.
router.get('/admin-contacts', ctrl.getAdminContacts)
// §O: create/delete staff is Org Admin only; a Manager may still list staff
// at their org for handover/tally context.
router.get('/', authorize('MANAGER', 'ORG_ADMIN'), ctrl.listStaff)
router.get('/on-duty', authorize('MANAGER', 'ORG_ADMIN'), ctrl.getOnDuty)
router.post('/', authorize('ORG_ADMIN'), validate(createStaff), ctrl.createStaff)
router.patch('/:id', authorize('ORG_ADMIN'), validate(updateStaff), ctrl.updateStaff)

module.exports = router
