const jwt = require('jsonwebtoken')
const PlatformAdmin = require('../models/PlatformAdmin')
const { createError } = require('../utils/helpers')

/**
 * protectPlatform — structurally separate from tenant protect() (§1.7):
 * different JWT secret (PLATFORM_JWT_SECRET), different account collection
 * (PlatformAdmin, not StaffUser). Mounted ONLY on the /platform/* router in
 * server.js, which never requires the tenant controllers — so even a bug in
 * this middleware can't grant tenant-mutation access, because the routes
 * simply don't exist on this router.
 */
const protectPlatform = async (req, res, next) => {
  try {
    let token
    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1]
    }
    if (!token) return next(createError(401, 'Not authorized: no token', null, 'UNAUTHENTICATED'))

    const decoded = jwt.verify(token, process.env.PLATFORM_JWT_SECRET, { algorithms: ['HS256'] })
    if (!decoded.platformAdmin) return next(createError(401, 'Invalid token', null, 'UNAUTHENTICATED'))

    const admin = await PlatformAdmin.findById(decoded.id).select('name email isActive')
    if (!admin || !admin.isActive) return next(createError(401, 'Account not found or deactivated', null, 'UNAUTHENTICATED'))

    req.platformAdmin = admin
    next()
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return next(createError(401, 'Invalid token', null, 'UNAUTHENTICATED'))
    if (err.name === 'TokenExpiredError') return next(createError(401, 'Token expired, please login again', null, 'UNAUTHENTICATED'))
    next(err)
  }
}

module.exports = { protectPlatform }
