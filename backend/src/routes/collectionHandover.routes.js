const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { initiateCollectionHandover, confirmCollectionHandover, rejectCollectionHandover } = require('../middleware/schemas')
const ctrl = require('../controllers/collectionHandover.controller')

router.use(protect, deviceCheck)

router.get('/', ctrl.list)
router.post('/', validate(initiateCollectionHandover), ctrl.initiate)
router.get('/:id', ctrl.loadHandover, ctrl.get)
// Only a Manager or Org Admin can confirm/reject receipt of cash (§ office-side control).
router.post('/:id/confirm', authorize('MANAGER', 'ORG_ADMIN'), validate(confirmCollectionHandover), ctrl.loadHandover, ctrl.confirm)
router.post('/:id/reject', authorize('MANAGER', 'ORG_ADMIN'), validate(rejectCollectionHandover), ctrl.loadHandover, ctrl.reject)

module.exports = router
