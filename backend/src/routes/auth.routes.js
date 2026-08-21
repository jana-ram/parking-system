const express = require('express')
const router = express.Router()
const validate = require('../middleware/validate.middleware')
const { staffLogin: staffLoginSchema } = require('../middleware/schemas')
const { staffLogin } = require('../controllers/auth.controller')

router.post('/staff/login', validate(staffLoginSchema), staffLogin)

module.exports = router
