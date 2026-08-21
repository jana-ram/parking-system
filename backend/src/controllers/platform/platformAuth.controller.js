const PlatformAdmin = require('../../models/PlatformAdmin')
const { createError } = require('../../utils/helpers')

const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body
    const admin = await PlatformAdmin.findOne({ email }).select('+password')
    if (!admin) return next(createError(401, 'Invalid email or password', null, 'UNAUTHENTICATED'))

    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      return next(createError(403, 'Account temporarily locked due to repeated failed logins. Try again later.', null, 'ACCOUNT_LOCKED'))
    }

    const matches = await admin.comparePassword(password)
    if (!matches) {
      admin.failedLoginAttempts += 1
      if (admin.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
        admin.lockedUntil = new Date(Date.now() + LOCKOUT_MS)
        admin.failedLoginAttempts = 0
      }
      await admin.save()
      return next(createError(401, 'Invalid email or password', null, 'UNAUTHENTICATED'))
    }
    if (!admin.isActive) return next(createError(403, 'Account deactivated', null, 'FORBIDDEN_ROLE'))

    admin.failedLoginAttempts = 0
    admin.lockedUntil = null
    admin.lastLogin = new Date()
    await admin.save()

    const token = admin.getSignedToken()
    res.json({
      success: true,
      message: 'Login successful',
      data: { token, admin: { id: admin._id, name: admin.name, email: admin.email } },
    })
  } catch (err) {
    next(err)
  }
}

module.exports = { login }
