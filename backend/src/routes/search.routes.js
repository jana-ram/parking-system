const express = require('express')
const router = express.Router()
const { protect } = require('../middleware/auth.middleware')
const deviceCheck = require('../middleware/deviceCheck.middleware')
const ctrl = require('../controllers/search.controller')

// Open to any authenticated role — same as /sessions/search already is.
// This is a counter-side lookup tool ("did this customer already check in?"),
// not a Manager-only report.
router.use(protect, deviceCheck)
router.get('/', ctrl.globalSearch)

module.exports = router
