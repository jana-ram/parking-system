const jwt = require('jsonwebtoken')
const StaffUser = require('../models/StaffUser')
const { createError } = require('../utils/helpers')

/**
 * protect — same shape as nammaraidu-web/backend/src/middleware/auth.middleware.js's
 * protect(), extended with the one check that middleware never needed before:
 * every existing app is single-tenant, so there was never an organizationId to
 * cross-check. Here, a JWT is only valid for the organization it was issued
 * against — req.staffUser carries the full account so downstream handlers
 * never have to re-fetch it.
 */
const protect = async (req, res, next) => {
  try {
    let token
    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1]
    }
    if (!token) return next(createError(401, 'Not authorized: no token', null, 'UNAUTHENTICATED'))

    // Explicit algorithms allowlist (defense-in-depth against algorithm-
    // confusion attacks) — jsonwebtoken 9.x already defaults sanely for a
    // symmetric secret, but pinning this removes any dependence on that
    // default staying safe across future upgrades.
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] })
    req.user = decoded // { id, organizationId, role, name }

    const staffUser = await StaffUser.findOne({ _id: decoded.id, organizationId: decoded.organizationId })
      .select('organizationId role status permissionOverrides name')
    if (!staffUser) return next(createError(401, 'Account not found', null, 'UNAUTHENTICATED'))
    if (staffUser.status !== 'ACTIVE') {
      return next(createError(403, 'Account deactivated. Contact your organization admin.', null, 'FORBIDDEN_ROLE'))
    }

    req.staffUser = staffUser
    next()
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return next(createError(401, 'Invalid token', null, 'UNAUTHENTICATED'))
    if (err.name === 'TokenExpiredError') return next(createError(401, 'Token expired, please login again', null, 'UNAUTHENTICATED'))
    next(err)
  }
}

// authorize('MANAGER','ORG_ADMIN') — same call shape as the existing backend's
// authorize(...roles), reading req.staffUser.role instead of req.user.role
// since protect() above already re-fetched (and validated) the live account.
const authorize = (...roles) => (req, res, next) => {
  if (!req.staffUser) return next(createError(401, 'Not authorized: no token', null, 'UNAUTHENTICATED'))
  if (roles.includes(req.staffUser.role)) return next()
  return next(createError(403, `Access denied: requires [${roles.join(', ')}]`, null, 'FORBIDDEN_ROLE'))
}

// hasPermission('pricing.edit') — walks StaffUser.permissionOverrides the same
// way the existing AdminRole.permissions[] check walks its permissions array
// (§O). ORG_ADMIN always passes; MANAGER/STAFF need an explicit GRANT override
// (DENY always wins if both are somehow present).
const hasPermission = (code) => (req, res, next) => {
  if (!req.staffUser) return next(createError(401, 'Not authorized: no token', null, 'UNAUTHENTICATED'))
  if (req.staffUser.role === 'ORG_ADMIN') return next()

  const overrides = req.staffUser.permissionOverrides || []
  const deny = overrides.some(o => o.code === code && o.effect === 'DENY')
  const grant = overrides.some(o => o.code === code && o.effect === 'GRANT')
  if (!deny && grant) return next()
  return next(createError(403, `Access denied: missing permission '${code}'`, null, 'FORBIDDEN_ROLE'))
}

// authorizeOrPermission(roles, code) — passes if the caller's role is in
// `roles`, OR they hold an explicit GRANT for permission `code` (DENY always
// wins over GRANT). The "role tier by default, permission override for a
// named exception" pattern pricingRule.routes.js has documented as intended-
// but-not-yet-wired since Phase 4 (§3/§O) — this is that wiring, not a new
// design. Kept as its own function rather than a generic authorize-OR-
// hasPermission combinator: composing arbitrary middleware as alternatives
// (vs. the usual all-must-pass chain) isn't a pattern this codebase uses
// anywhere else, and one clear function for this one real need beats a
// generic combinator with no second caller yet.
const authorizeOrPermission = (roles, code) => (req, res, next) => {
  if (!req.staffUser) return next(createError(401, 'Not authorized: no token', null, 'UNAUTHENTICATED'))
  if (roles.includes(req.staffUser.role)) return next()

  const overrides = req.staffUser.permissionOverrides || []
  const deny = overrides.some(o => o.code === code && o.effect === 'DENY')
  const grant = overrides.some(o => o.code === code && o.effect === 'GRANT')
  if (!deny && grant) return next()
  return next(createError(403, `Access denied: requires [${roles.join(', ')}] or permission '${code}'`, null, 'FORBIDDEN_ROLE'))
}

const adminOnly = (req, res, next) => {
  if (req.staffUser?.role === 'ORG_ADMIN') return next()
  return next(createError(403, 'Org Admin only', null, 'FORBIDDEN_ROLE'))
}

module.exports = { protect, authorize, hasPermission, authorizeOrPermission, adminOnly }
