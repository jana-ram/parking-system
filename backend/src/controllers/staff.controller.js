const StaffUser = require('../models/StaffUser')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

const PROFILE_FIELDS = 'name phone email role status createdAt lastLogin'

const getMe = async (req, res, next) => {
  try {
    const staff = await StaffUser.findOne({ _id: req.staffUser._id, organizationId: req.staffUser.organizationId }).select(PROFILE_FIELDS)
    if (!staff) return next(createError(404, 'Staff account not found', null, 'NOT_FOUND'))
    res.json({ success: true, message: 'ok', data: { staff: { id: staff._id, ...staff.toObject({ versionKey: false }) } } })
  } catch (err) {
    next(err)
  }
}

const updateMe = async (req, res, next) => {
  try {
    const { name, email, currentPassword, newPassword } = req.body
    const staff = await StaffUser.findOne({ _id: req.staffUser._id, organizationId: req.staffUser.organizationId }).select('+password')
    if (!staff) return next(createError(404, 'Staff account not found', null, 'NOT_FOUND'))

    if (newPassword) {
      const matches = await staff.comparePassword(currentPassword)
      if (!matches) return next(createError(401, 'Current password is incorrect', null, 'UNAUTHENTICATED'))
      staff.password = newPassword
    }
    if (name !== undefined) staff.name = name
    if (email !== undefined) staff.email = email
    await staff.save()

    await auditLog.record(req, {
      action: 'STAFF_UPDATED',
      entityType: 'StaffUser',
      entityId: staff._id,
      newValue: { name: staff.name, email: staff.email, passwordChanged: !!newPassword },
    })

    res.json({
      success: true,
      message: 'Profile updated',
      data: { staff: { id: staff._id, name: staff.name, phone: staff.phone, email: staff.email, role: staff.role, status: staff.status } },
    })
  } catch (err) {
    next(err)
  }
}

const listStaff = async (req, res, next) => {
  try {
    // Shaped to {id, ...} like every other staff endpoint below (createStaff/
    // updateStaff/getMe) — this one was returning raw Mongoose docs (`_id`,
    // no `id`) instead, a real bug the mobile Staff screen's edit/
    // activate/deactivate actions hit immediately (item.id was undefined,
    // so every action PATCHed `/staff/undefined`).
    const staff = await StaffUser.find({ organizationId: req.staffUser.organizationId })
      .select(PROFILE_FIELDS)
      .sort({ name: 1 })
    res.json({
      success: true,
      message: 'ok',
      data: { staff: staff.map((s) => ({ id: s._id, name: s.name, phone: s.phone, email: s.email, role: s.role, status: s.status, createdAt: s.createdAt, lastLogin: s.lastLogin })) },
    })
  } catch (err) {
    next(err)
  }
}

const createStaff = async (req, res, next) => {
  try {
    const staff = await StaffUser.create({
      ...req.body,
      organizationId: req.staffUser.organizationId,
      createdBy: req.staffUser._id,
    })

    await auditLog.record(req, {
      action: 'STAFF_CREATED',
      entityType: 'StaffUser',
      entityId: staff._id,
      newValue: { name: staff.name, phone: staff.phone, role: staff.role },
    })

    res.status(201).json({
      success: true,
      message: 'Staff account created',
      data: { staff: { id: staff._id, name: staff.name, phone: staff.phone, role: staff.role, status: staff.status } },
    })
  } catch (err) {
    if (err.code === 11000) return next(createError(409, 'A staff account with this phone number already exists', null, 'VALIDATION_ERROR'))
    next(err)
  }
}

const updateStaff = async (req, res, next) => {
  try {
    const staff = await StaffUser.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!staff) return next(createError(404, 'Staff account not found', null, 'NOT_FOUND'))

    const oldValue = { name: staff.name, email: staff.email, role: staff.role, status: staff.status }
    const oldAction = req.body.status && req.body.status !== staff.status ? 'STAFF_ROLE_CHANGED' : 'STAFF_UPDATED'
    Object.assign(staff, req.body)
    await staff.save()

    await auditLog.record(req, {
      action: req.body.status === 'SUSPENDED' ? 'STAFF_DEACTIVATED' : oldAction,
      entityType: 'StaffUser',
      entityId: staff._id,
      oldValue,
      newValue: req.body,
    })

    res.json({
      success: true,
      message: 'Staff account updated',
      data: { staff: { id: staff._id, name: staff.name, phone: staff.phone, role: staff.role, status: staff.status } },
    })
  } catch (err) {
    next(err)
  }
}

module.exports = { listStaff, createStaff, updateStaff, getMe, updateMe }
