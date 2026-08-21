const Location = require('../models/Location')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

const listLocations = async (req, res, next) => {
  try {
    const locations = await Location.find({ organizationId: req.staffUser.organizationId }).sort({ name: 1 })
    res.json({ success: true, message: 'ok', data: { locations } })
  } catch (err) {
    next(err)
  }
}

const getLocation = async (req, res, next) => {
  try {
    const location = await Location.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!location) return next(createError(404, 'Location not found', null, 'NOT_FOUND'))
    res.json({ success: true, message: 'ok', data: { location } })
  } catch (err) {
    next(err)
  }
}

const createLocation = async (req, res, next) => {
  try {
    const location = await Location.create({ ...req.body, organizationId: req.staffUser.organizationId })
    await auditLog.record(req, {
      action: 'LOCATION_CREATED',
      entityType: 'Location',
      entityId: location._id,
      newValue: req.body,
      locationId: location._id,
    })
    res.status(201).json({ success: true, message: 'Location created', data: { location } })
  } catch (err) {
    next(err)
  }
}

const updateLocation = async (req, res, next) => {
  try {
    const location = await Location.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!location) return next(createError(404, 'Location not found', null, 'NOT_FOUND'))

    const oldValue = location.toObject()
    Object.assign(location, req.body)
    await location.save()

    await auditLog.record(req, {
      action: 'LOCATION_UPDATED',
      entityType: 'Location',
      entityId: location._id,
      oldValue,
      newValue: req.body,
      locationId: location._id,
    })

    res.json({ success: true, message: 'Location updated', data: { location } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listLocations, getLocation, createLocation, updateLocation }
