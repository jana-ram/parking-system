const express = require('express')
const router = express.Router()
const { protectPlatform } = require('../../middleware/platformAuth.middleware')
const validate = require('../../middleware/validate.middleware')
const { createOrganization, updateOrganizationStatus } = require('../../middleware/schemas')
const ctrl = require('../../controllers/platform/platformOrg.controller')

router.use(protectPlatform)
router.get('/', ctrl.listOrganizations)
router.post('/', validate(createOrganization), ctrl.createOrganization)
router.get('/:id', ctrl.getOrganization)
router.patch('/:id/status', validate(updateOrganizationStatus), ctrl.updateOrganizationStatus)

module.exports = router
