const ParkingArea = require('../models/ParkingArea')
const ParkingSlot = require('../models/ParkingSlot')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

const listParkingAreas = async (req, res, next) => {
  try {
    const filter = { organizationId: req.staffUser.organizationId }
    if (req.query.locationId) filter.locationId = req.query.locationId
    const parkingAreas = await ParkingArea.find(filter).sort({ name: 1 })
    res.json({ success: true, message: 'ok', data: { parkingAreas } })
  } catch (err) {
    next(err)
  }
}

const createParkingArea = async (req, res, next) => {
  try {
    const parkingArea = await ParkingArea.create({ ...req.body, organizationId: req.staffUser.organizationId })
    await auditLog.record(req, {
      action: 'PARKING_AREA_CREATED', entityType: 'ParkingArea', entityId: parkingArea._id,
      newValue: req.body, locationId: parkingArea.locationId,
    })
    res.status(201).json({ success: true, message: 'Parking area created', data: { parkingArea } })
  } catch (err) {
    next(err)
  }
}

const listSlots = async (req, res, next) => {
  try {
    const parkingArea = await ParkingArea.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!parkingArea) return next(createError(404, 'Parking area not found', null, 'NOT_FOUND'))

    const filter = { organizationId: req.staffUser.organizationId, parkingAreaId: parkingArea._id }
    if (req.query.status) filter.status = req.query.status
    const slots = await ParkingSlot.find(filter).sort({ slotNumber: 1 })
    res.json({ success: true, message: 'ok', data: { slots } })
  } catch (err) {
    next(err)
  }
}

const createSlots = async (req, res, next) => {
  try {
    const parkingArea = await ParkingArea.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!parkingArea) return next(createError(404, 'Parking area not found', null, 'NOT_FOUND'))

    const { slotNumbers, vehicleTypeId } = req.body
    const docs = slotNumbers.map((slotNumber) => ({
      organizationId: req.staffUser.organizationId, parkingAreaId: parkingArea._id, slotNumber, vehicleTypeId: vehicleTypeId || undefined,
    }))
    const slots = await ParkingSlot.insertMany(docs, { ordered: false })

    await auditLog.record(req, {
      action: 'PARKING_SLOTS_CREATED', entityType: 'ParkingArea', entityId: parkingArea._id,
      newValue: { count: slots.length, slotNumbers }, locationId: parkingArea.locationId,
    })
    res.status(201).json({ success: true, message: 'Slots created', data: { slots } })
  } catch (err) {
    if (err.code === 11000) return next(createError(409, 'One or more slot numbers already exist in this area', null, 'VALIDATION_ERROR'))
    next(err)
  }
}

module.exports = { listParkingAreas, createParkingArea, listSlots, createSlots }
