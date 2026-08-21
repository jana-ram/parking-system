const Organization = require('../models/Organization')
const StaffUser = require('../models/StaffUser')
const { createError } = require('../utils/helpers')

const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

/**
 * POST /auth/staff/login — { orgCode, phone, password }
 * Phase 1 slice: enough to prove StaffUser + Organization + JWT issuance work
 * end-to-end. Device binding (§N) and refresh-token rotation land with the
 * device/session module in Phase 2.
 */
const staffLogin = async (req, res, next) => {
  try {
    const { orgCode, phone, password } = req.body
    if (!orgCode) return next(createError(422, 'orgCode is required', null, 'VALIDATION_ERROR'))

    // Organization carries no organizationId field (it IS the tenant root, §E),
    // so requireOrgScope was never applied to it — nothing to opt out of here.
    const organization = await Organization.findOne({ code: orgCode })
    if (!organization || organization.status !== 'ACTIVE') {
      return next(createError(401, 'Invalid organization, phone, or password', null, 'UNAUTHENTICATED'))
    }

    const staffUser = await StaffUser.findOne({ organizationId: organization._id, phone }).select('+password')
    if (!staffUser) {
      return next(createError(401, 'Invalid organization, phone, or password', null, 'UNAUTHENTICATED'))
    }

    if (staffUser.lockedUntil && staffUser.lockedUntil > new Date()) {
      return next(createError(403, 'Account temporarily locked due to repeated failed logins. Try again later.', null, 'ACCOUNT_LOCKED'))
    }

    const matches = await staffUser.comparePassword(password)
    if (!matches) {
      staffUser.failedLoginAttempts += 1
      if (staffUser.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
        staffUser.lockedUntil = new Date(Date.now() + LOCKOUT_MS)
        staffUser.failedLoginAttempts = 0
      }
      await staffUser.save()
      return next(createError(401, 'Invalid organization, phone, or password', null, 'UNAUTHENTICATED'))
    }

    if (staffUser.status !== 'ACTIVE') {
      return next(createError(403, 'Account deactivated. Contact your organization admin.', null, 'FORBIDDEN_ROLE'))
    }

    staffUser.failedLoginAttempts = 0
    staffUser.lockedUntil = null
    staffUser.lastLogin = new Date()
    await staffUser.save()

    const token = staffUser.getSignedToken()
    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        staffUser: {
          id: staffUser._id,
          organizationId: staffUser.organizationId,
          name: staffUser.name,
          role: staffUser.role,
        },
      },
    })
  } catch (err) {
    next(err)
  }
}

module.exports = { staffLogin }
