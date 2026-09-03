/**
 * publicOrgContext — resolves :orgCode into an active Organization with
 * CUSTOMER_SELF_SERVICE enabled, for the one router that deliberately has no
 * staff JWT (§24: a customer, not a staff member, is the caller). Mirrors
 * requireFeature.middleware.js's flag check but can't reuse it directly —
 * that one reads req.staffUser.organizationId, which doesn't exist here.
 * Never leaks WHY a lookup is unavailable (wrong org vs. feature off vs.
 * suspended) beyond a generic 404 — an unauthenticated caller doesn't need
 * to learn which orgs exist or which have this feature toggled.
 */
const Organization = require('../models/Organization')
const { createError } = require('../utils/helpers')

const publicOrgContext = async (req, res, next) => {
  try {
    const org = await Organization.findOne({ code: req.params.orgCode, status: 'ACTIVE' })
    if (!org || !org.modules?.CUSTOMER_SELF_SERVICE) {
      return next(createError(404, 'Not found', null, 'NOT_FOUND'))
    }
    req.publicOrg = org
    next()
  } catch (err) {
    next(err)
  }
}

module.exports = publicOrgContext
