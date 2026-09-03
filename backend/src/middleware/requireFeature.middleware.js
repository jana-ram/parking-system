const Organization = require('../models/Organization')
const { createError } = require('../utils/helpers')

/**
 * requireFeature('RACK') — gates a whole router (or a single route) behind
 * the caller's organization having that module enabled (§2). Same
 * factory-function shape as authorize()/hasPermission() in
 * auth.middleware.js. Must run after protect() (needs req.staffUser).
 *
 * This is the server-side enforcement half of feature gating — a disabled
 * module must 403 here even if a client calls the API directly, not merely
 * be hidden in a UI.
 */
const requireFeature = (moduleKey) => async (req, res, next) => {
  try {
    if (!req.staffUser) return next(createError(401, 'Not authorized: no token', null, 'UNAUTHENTICATED'))

    const org = await Organization.findById(req.staffUser.organizationId).select('modules')
    if (!org) return next(createError(404, 'Organization not found', null, 'NOT_FOUND'))

    if (!org.modules?.[moduleKey]) {
      return next(createError(403, `The '${moduleKey}' module is not enabled for your organization`, null, 'FEATURE_DISABLED'))
    }

    next()
  } catch (err) {
    next(err)
  }
}

module.exports = requireFeature
