const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const requireFeature = require('../middleware/requireFeature.middleware')
const shiftCheck = require('../middleware/shiftCheck.middleware')
const validate = require('../middleware/validate.middleware')
const {
  createParcelOrder, addParcelItems, recordParcelPayment, cancelParcelOrder, parcelOverrideAmount,
} = require('../middleware/schemas')
const ctrl = require('../controllers/parcel.controller')

router.use(protect, deviceCheck, requireFeature('PARCEL'))

router.get('/', ctrl.listOrders)
router.get('/:id', ctrl.getOrder)

router.post('/', shiftCheck, validate(createParcelOrder), ctrl.createOrder)
router.post('/:id/items', shiftCheck, validate(addParcelItems), ctrl.addItems)
router.post('/:id/payment', shiftCheck, validate(recordParcelPayment), ctrl.recordPayment)
router.post('/:id/pickup', shiftCheck, ctrl.pickup)

router.post('/:id/cancel', authorize('MANAGER', 'ORG_ADMIN'), validate(cancelParcelOrder), ctrl.cancelOrder)
router.post('/:id/override-amount', authorize('MANAGER', 'ORG_ADMIN'), validate(parcelOverrideAmount), ctrl.overrideAmount)

module.exports = router
