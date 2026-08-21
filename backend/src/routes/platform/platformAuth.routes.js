const express = require('express')
const router = express.Router()
const validate = require('../../middleware/validate.middleware')
const { platformLogin } = require('../../middleware/schemas')
const { login } = require('../../controllers/platform/platformAuth.controller')

router.post('/login', validate(platformLogin), login)

module.exports = router
