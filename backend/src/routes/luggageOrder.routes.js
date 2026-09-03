const express = require('express')
const router = express.Router()
const { protect, authorize } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const requireFeature = require('../middleware/requireFeature.middleware')
const shiftCheck = require('../middleware/shiftCheck.middleware')
const validate = require('../middleware/validate.middleware')
const {
  createLuggageOrder, addLuggageItems, recordLuggagePayment, cancelLuggageOrder, luggageOverrideAmount,
} = require('../middleware/schemas')
const ctrl = require('../controllers/luggage.controller')

router.use(protect, deviceCheck, requireFeature('LUGGAGE'))

// Read-only — no active shift required to browse/search (§4 convention).
// by-code MUST precede /:id — Express would otherwise match "by-code" as an :id value.
router.get('/', ctrl.listOrders)
router.get('/by-code/:orderCode', ctrl.getOrderByCode)
router.get('/:id', ctrl.getOrder)

// Operational, counter-side writes — bound to an active shift, same tier as
// session entry/payment.
router.post('/', shiftCheck, validate(createLuggageOrder), ctrl.createOrder)
router.post('/:id/items', shiftCheck, validate(addLuggageItems), ctrl.addItems)
router.post('/:id/payment', shiftCheck, validate(recordLuggagePayment), ctrl.recordPayment)
router.post('/:id/pickup', shiftCheck, ctrl.pickup)

// Administrative overrides — Manager+, no shift required, same tier as
// session cancel/override-amount.
router.post('/:id/cancel', authorize('MANAGER', 'ORG_ADMIN'), validate(cancelLuggageOrder), ctrl.cancelOrder)
router.post('/:id/override-amount', authorize('MANAGER', 'ORG_ADMIN'), validate(luggageOverrideAmount), ctrl.overrideAmount)

module.exports = router
