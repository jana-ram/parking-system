const express = require('express')
const router = express.Router()
const { protect } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const validate = require('../middleware/validate.middleware')
const { syncPush } = require('../middleware/schemas')
const ctrl = require('../controllers/sync.controller')

// Sync itself IS the sensitive-write path (§23) — full protect + deviceCheck,
// same as every other mutating route, no special-casing "it's just sync."
router.use(protect, deviceCheck)
router.post('/push', validate(syncPush), ctrl.push)
router.get('/pull', ctrl.pull)

module.exports = router
