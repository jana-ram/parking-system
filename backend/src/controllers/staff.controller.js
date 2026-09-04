const StaffUser = require('../models/StaffUser')
const ShiftInstance = require('../models/ShiftInstance')
const Location = require('../models/Location')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

const PROFILE_FIELDS = 'name phone email role status createdAt lastLogin'
// listStaff (Org Admin's roster view, to show/edit another account's
// exception) and getMe (§3/§O: a Manager/Staff needs to see their OWN
// GRANT/DENY overrides — e.g. 'pricing.edit' — so the app can show/hide
// write actions before the API 403s them, not after) both need this.
const LIST_FIELDS = `${PROFILE_FIELDS} permissionOverrides`

const getMe = async (req, res, next) => {
  try {
    const staff = await StaffUser.findOne({ _id: req.staffUser._id, organizationId: req.staffUser.organizationId }).select(LIST_FIELDS)
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
      .select(LIST_FIELDS)
      .sort({ name: 1 })
    res.json({
      success: true,
      message: 'ok',
      data: { staff: staff.map((s) => ({ id: s._id, name: s.name, phone: s.phone, email: s.email, role: s.role, status: s.status, createdAt: s.createdAt, lastLogin: s.lastLogin, permissionOverrides: s.permissionOverrides })) },
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

/**
 * GET /staff/on-duty — Manager+: which staff is on shift where, right now
 * (open ShiftInstances joined to StaffUser for name/phone and Location for
 * name). No schema change needed — "on duty" is exactly an OPEN shift,
 * already tracked; this is a read, not a new concept.
 */
const getOnDuty = async (req, res, next) => {
  try {
    const shifts = await ShiftInstance.find({ organizationId: req.staffUser.organizationId, status: 'OPEN' }).sort({ openedAt: -1 })
    const [staffDocs, locationDocs] = await Promise.all([
      StaffUser.find({ organizationId: req.staffUser.organizationId, _id: { $in: shifts.map((s) => s.staffId) } }).select('name phone role'),
      Location.find({ organizationId: req.staffUser.organizationId, _id: { $in: shifts.map((s) => s.locationId) } }).select('name'),
    ])
    const staffById = Object.fromEntries(staffDocs.map((s) => [String(s._id), s]))
    const locationById = Object.fromEntries(locationDocs.map((l) => [String(l._id), l]))

    const onDuty = shifts.map((shift) => {
      const staff = staffById[String(shift.staffId)]
      const location = locationById[String(shift.locationId)]
      return {
        shiftInstanceId: shift._id, openedAt: shift.openedAt,
        staffId: shift.staffId, staffName: staff?.name ?? 'Unknown', staffPhone: staff?.phone ?? null, staffRole: staff?.role ?? null,
        locationId: shift.locationId, locationName: location?.name ?? 'Unknown',
      }
    })
    res.json({ success: true, message: 'ok', data: { onDuty } })
  } catch (err) {
    next(err)
  }
}

/**
 * GET /staff/admin-contacts — any authenticated staff role (not just
 * Manager+): the "Call Admin" number(s) for their org. No config field
 * needed — Org Admin is already a role, so this just queries it rather than
 * inventing a settings field for something already expressible.
 */
const getAdminContacts = async (req, res, next) => {
  try {
    const admins = await StaffUser.find({ organizationId: req.staffUser.organizationId, role: 'ORG_ADMIN', status: 'ACTIVE' }).select('name phone')
    res.json({ success: true, message: 'ok', data: { admins: admins.map((a) => ({ id: a._id, name: a.name, phone: a.phone })) } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listStaff, createStaff, updateStaff, getMe, updateMe, getOnDuty, getAdminContacts }
