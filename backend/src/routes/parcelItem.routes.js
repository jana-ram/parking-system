const express = require('express')
const router = express.Router()
const { protect } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const requireFeature = require('../middleware/requireFeature.middleware')
const shiftCheck = require('../middleware/shiftCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { assignParcelItemRack, releaseParcelItemRack } = require('../middleware/schemas')
const ctrl = require('../controllers/parcel.controller')

router.use(protect, deviceCheck, requireFeature('PARCEL'), shiftCheck)
router.post('/:id/assign-rack', validate(assignParcelItemRack), ctrl.assignItemRack)
router.post('/:id/release-rack', validate(releaseParcelItemRack), ctrl.releaseItemRack)

module.exports = router
