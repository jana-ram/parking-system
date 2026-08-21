const StaffUser = require('../models/StaffUser')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

const listStaff = async (req, res, next) => {
  try {
    const staff = await StaffUser.find({ organizationId: req.staffUser.organizationId }).sort({ name: 1 })
    res.json({ success: true, message: 'ok', data: { staff } })
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

module.exports = { listStaff, createStaff, updateStaff }
