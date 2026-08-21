const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { createStaff, updateStaff } = require('../middleware/schemas')
const ctrl = require('../controllers/staff.controller')

router.use(protect, deviceCheck)
// §O: create/delete staff is Org Admin only; a Manager may still list staff
// at their org for handover/tally context.
router.get('/', authorize('MANAGER', 'ORG_ADMIN'), ctrl.listStaff)
router.post('/', authorize('ORG_ADMIN'), validate(createStaff), ctrl.createStaff)
router.patch('/:id', authorize('ORG_ADMIN'), validate(updateStaff), ctrl.updateStaff)

module.exports = router
