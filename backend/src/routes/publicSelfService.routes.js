const express = require('express')
const router = express.Router({ mergeParams: true })
const publicOrgContext = require('../middleware/publicOrgContext.middleware')
const ctrl = require('../controllers/publicSelfService.controller')

// No protect()/deviceCheck() — this is the one router in the whole backend
// deliberately reachable without a staff JWT (§24). publicOrgContext is the
// equivalent gate: resolves :orgCode and requires CUSTOMER_SELF_SERVICE.
router.use(publicOrgContext)
router.get('/luggage/:orderCode', ctrl.getLuggageStatus)
router.get('/parcel/:orderCode', ctrl.getParcelStatus)

module.exports = router
