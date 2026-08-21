const VehicleType = require('../models/VehicleType')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

const listVehicleTypes = async (req, res, next) => {
  try {
    const vehicleTypes = await VehicleType.find({ organizationId: req.staffUser.organizationId, isActive: true }).sort({ name: 1 })
    res.json({ success: true, message: 'ok', data: { vehicleTypes } })
  } catch (err) {
    next(err)
  }
}

const createVehicleType = async (req, res, next) => {
  try {
    const vehicleType = await VehicleType.create({ ...req.body, organizationId: req.staffUser.organizationId })
    await auditLog.record(req, { action: 'VEHICLE_TYPE_CREATED', entityType: 'VehicleType', entityId: vehicleType._id, newValue: req.body })
    res.status(201).json({ success: true, message: 'Vehicle type created', data: { vehicleType } })
  } catch (err) {
    if (err.code === 11000) return next(createError(409, 'A vehicle type with this code already exists', null, 'VALIDATION_ERROR'))
    next(err)
  }
}

module.exports = { listVehicleTypes, createVehicleType }
