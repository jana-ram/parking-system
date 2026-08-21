/**
 * StaffUser — Org Admin / Manager / Staff accounts (§3). A third, structurally
 * distinct account type from the ride-hailing side's User (customer) and
 * AdminRole (single-tenant platform staff) models — deliberately not reusing
 * either, matching the isolation intent in docs/ARCHITECTURE.md §1.7.
 *
 * permissionOverrides mirrors AdminRole's permissions[]-for-the-support-role
 * idea: the base `role` enum covers the common case, and GRANT/DENY overrides
 * (e.g. letting one specific Manager edit pricing, per §4) are layered on top,
 * checked by hasPermission() in auth.middleware.js.
 */
const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const requireOrgScope = require('../plugins/requireOrgScope')

const ROLES = ['ORG_ADMIN', 'MANAGER', 'STAFF']
const STATUSES = ['ACTIVE', 'SUSPENDED']

const StaffUserSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  email: { type: String, lowercase: true, trim: true },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ROLES, required: true },
  permissionOverrides: [{
    code: { type: String, required: true },
    effect: { type: String, enum: ['GRANT', 'DENY'], required: true },
  }],
  status: { type: String, enum: STATUSES, default: 'ACTIVE' },
  failedLoginAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  lastLogin: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' },
}, { timestamps: true })

StaffUserSchema.index({ organizationId: 1, phone: 1 }, { unique: true })

StaffUserSchema.pre('save', async function hashPassword(next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 12)
  }
  next()
})

StaffUserSchema.methods.comparePassword = async function comparePassword(pw) {
  return bcrypt.compare(pw, this.password)
}

StaffUserSchema.methods.getSignedToken = function getSignedToken() {
  return jwt.sign(
    { id: this._id, organizationId: this.organizationId, role: this.role, name: this.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '12h', algorithm: 'HS256' }
  )
}

StaffUserSchema.statics.ROLES = ROLES
StaffUserSchema.statics.STATUSES = STATUSES
StaffUserSchema.plugin(requireOrgScope)

module.exports = mongoose.model('StaffUser', StaffUserSchema)
