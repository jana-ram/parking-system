const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { updateOrg } = require('../middleware/schemas')
const ctrl = require('../controllers/org.controller')

router.use(protect, deviceCheck)
router.get('/me', ctrl.getMe)
router.patch('/me', authorize('ORG_ADMIN'), validate(updateOrg), ctrl.updateMe)

module.exports = router
