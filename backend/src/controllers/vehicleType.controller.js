const VehicleType = require('../models/VehicleType')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

// The model stores isActive as a boolean; the mobile app (and this API's own
// wire shape below) works in terms of a two-value `status` string instead —
// this is the one place that translation happens, so callers never touch
// isActive directly.
function serialize(vehicleType) {
  return { ...vehicleType.toObject(), status: vehicleType.isActive ? 'ACTIVE' : 'INACTIVE' }
}

const listVehicleTypes = async (req, res, next) => {
  try {
    const vehicleTypes = await VehicleType.find({ organizationId: req.staffUser.organizationId, isActive: true }).sort({ name: 1 })
    res.json({ success: true, message: 'ok', data: { vehicleTypes: vehicleTypes.map(serialize) } })
  } catch (err) {
    next(err)
  }
}

const createVehicleType = async (req, res, next) => {
  try {
    const vehicleType = await VehicleType.create({ ...req.body, organizationId: req.staffUser.organizationId })
    await auditLog.record(req, { action: 'VEHICLE_TYPE_CREATED', entityType: 'VehicleType', entityId: vehicleType._id, newValue: req.body })
    res.status(201).json({ success: true, message: 'Vehicle type created', data: { vehicleType: serialize(vehicleType) } })
  } catch (err) {
    if (err.code === 11000) return next(createError(409, 'A vehicle type with this code already exists', null, 'VALIDATION_ERROR'))
    next(err)
  }
}

/**
 * PATCH /vehicle-types/:id — rename, re-code, or deactivate. This existed as
 * a mobile API call (vehicleTypeAPI.update) with no matching route at all —
 * every Edit/Deactivate tap on VehicleTypesScreen 404'd for every role,
 * found while auditing the app's write paths end-to-end.
 */
const updateVehicleType = async (req, res, next) => {
  try {
    const vehicleType = await VehicleType.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!vehicleType) return next(createError(404, 'Vehicle type not found', null, 'NOT_FOUND'))

    const { code, name, status } = req.body
    const oldValue = { code: vehicleType.code, name: vehicleType.name, isActive: vehicleType.isActive }
    if (code !== undefined) vehicleType.code = code
    if (name !== undefined) vehicleType.name = name
    if (status !== undefined) vehicleType.isActive = status === 'ACTIVE'
    await vehicleType.save()

    await auditLog.record(req, {
      action: 'VEHICLE_TYPE_UPDATED', entityType: 'VehicleType', entityId: vehicleType._id,
      oldValue, newValue: { code: vehicleType.code, name: vehicleType.name, isActive: vehicleType.isActive },
    })

    res.json({ success: true, message: 'Vehicle type updated', data: { vehicleType: serialize(vehicleType) } })
  } catch (err) {
    if (err.code === 11000) return next(createError(409, 'A vehicle type with this code already exists', null, 'VALIDATION_ERROR'))
    next(err)
  }
}

module.exports = { listVehicleTypes, createVehicleType, updateVehicleType }
