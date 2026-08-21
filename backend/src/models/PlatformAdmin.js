/**
 * PlatformAdmin — our own SaaS company's staff, NOT a tenant account. Deliberately
 * a separate collection/auth realm from StaffUser (§1.7) — different login route
 * (/platform/auth/login), different JWT secret (PLATFORM_JWT_SECRET), no shared
 * password store with any tenant. This structural separation is what makes "the
 * Product Owner dashboard can never accidentally become a tenant login path" true
 * by construction rather than by a permission check that could be misconfigured.
 */
const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

const PlatformAdminSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, select: false },
  isActive: { type: Boolean, default: true },
  failedLoginAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  lastLogin: Date,
}, { timestamps: true })

PlatformAdminSchema.pre('save', async function hashPassword(next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 12)
  }
  next()
})

PlatformAdminSchema.methods.comparePassword = async function comparePassword(pw) {
  return bcrypt.compare(pw, this.password)
}

PlatformAdminSchema.methods.getSignedToken = function getSignedToken() {
  return jwt.sign(
    { id: this._id, email: this.email, platformAdmin: true },
    process.env.PLATFORM_JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '12h', algorithm: 'HS256' }
  )
}

module.exports = mongoose.model('PlatformAdmin', PlatformAdminSchema)
