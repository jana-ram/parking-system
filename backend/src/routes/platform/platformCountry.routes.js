const express = require('express')
const router = express.Router()
const { protectPlatform } = require('../../middleware/platformAuth.middleware')
const validate = require('../../middleware/validate.middleware')
const { createCountry } = require('../../middleware/schemas')
const ctrl = require('../../controllers/platform/platformCountry.controller')

router.use(protectPlatform)
router.get('/', ctrl.listCountries)
router.post('/', validate(createCountry), ctrl.createCountry)

module.exports = router
