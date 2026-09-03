const Rack = require('../models/Rack')
const RackSlot = require('../models/RackSlot')
const RackSlotMovement = require('../models/RackSlotMovement')
const rackSlotStateMachine = require('../domain/rackSlotStateMachine')
const { suggestSlot } = require('../domain/rackAssignment')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

const listRacks = async (req, res, next) => {
  try {
    const filter = { organizationId: req.staffUser.organizationId }
    if (req.query.locationId) filter.locationId = req.query.locationId
    const racks = await Rack.find(filter).sort({ code: 1 })
    res.json({ success: true, message: 'ok', data: { racks } })
  } catch (err) {
    next(err)
  }
}

const createRack = async (req, res, next) => {
  try {
    const rack = await Rack.create({ ...req.body, organizationId: req.staffUser.organizationId })
    await auditLog.record(req, {
      action: 'RACK_CREATED', entityType: 'Rack', entityId: rack._id,
      newValue: req.body, locationId: rack.locationId,
    })
    res.status(201).json({ success: true, message: 'Rack created', data: { rack } })
  } catch (err) {
    if (err.code === 11000) return next(createError(409, 'A rack with this code already exists at this location', null, 'VALIDATION_ERROR'))
    next(err)
  }
}

const updateRack = async (req, res, next) => {
  try {
    const rack = await Rack.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!rack) return next(createError(404, 'Rack not found', null, 'NOT_FOUND'))

    const oldValue = rack.toObject()
    Object.assign(rack, req.body)
    await rack.save()

    await auditLog.record(req, {
      action: 'RACK_UPDATED', entityType: 'Rack', entityId: rack._id,
      oldValue, newValue: req.body, locationId: rack.locationId,
    })
    res.json({ success: true, message: 'Rack updated', data: { rack } })
  } catch (err) {
    next(err)
  }
}

const listSlots = async (req, res, next) => {
  try {
    const rack = await Rack.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!rack) return next(createError(404, 'Rack not found', null, 'NOT_FOUND'))

    const filter = { organizationId: req.staffUser.organizationId, rackId: rack._id }
    if (req.query.status) filter.status = req.query.status
    const slots = await RackSlot.find(filter).sort({ slotCode: 1 })
    res.json({ success: true, message: 'ok', data: { slots } })
  } catch (err) {
    next(err)
  }
}

const createSlots = async (req, res, next) => {
  try {
    const rack = await Rack.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!rack) return next(createError(404, 'Rack not found', null, 'NOT_FOUND'))

    const docs = req.body.slots.map((slot) => ({
      ...slot,
      organizationId: req.staffUser.organizationId,
      rackId: rack._id,
      locationId: rack.locationId,
    }))
    const slots = await RackSlot.insertMany(docs, { ordered: false })

    await auditLog.record(req, {
      action: 'RACK_SLOTS_CREATED', entityType: 'Rack', entityId: rack._id,
      newValue: { count: slots.length }, locationId: rack.locationId,
    })
    res.status(201).json({ success: true, message: 'Slots created', data: { slots } })
  } catch (err) {
    if (err.code === 11000) return next(createError(409, 'One or more slot codes already exist in this rack', null, 'VALIDATION_ERROR'))
    next(err)
  }
}

// GET /rack-slots/suggest — the smart-assignment lookup (§6): scores
// candidates by item type / size / weight / security fit rather than
// returning the first AVAILABLE slot found.
const suggestRackSlot = async (req, res, next) => {
  try {
    const { locationId, itemType, weightKg, securityLevel, lengthCm, widthCm, heightCm } = req.query
    if (!locationId || !itemType) {
      return next(createError(422, 'locationId and itemType are required', null, 'VALIDATION_ERROR'))
    }

    const candidates = await RackSlot.find({
      organizationId: req.staffUser.organizationId,
      locationId,
      status: { $in: ['AVAILABLE', 'RESERVED'] },
    }).lean()

    const dimensions = (lengthCm != null || widthCm != null || heightCm != null)
      ? { lengthCm: Number(lengthCm), widthCm: Number(widthCm), heightCm: Number(heightCm) }
      : undefined

    const best = suggestSlot(candidates, {
      itemType,
      weightKg: weightKg != null ? Number(weightKg) : undefined,
      dimensions,
      securityLevel,
    })
    if (!best) return next(createError(404, 'No suitable rack slot is available', null, 'NO_SLOT_AVAILABLE'))

    res.json({ success: true, message: 'ok', data: { slot: best } })
  } catch (err) {
    next(err)
  }
}

// POST /rack-slots/:id/assign — an operational, counter-side write (like
// session entry), so it's bound to staff + active shift + device (§ non-
// negotiable 5), unlike the administrative rack/slot CRUD above.
const assignSlot = async (req, res, next) => {
  try {
    const { itemType, itemRef, reason } = req.body
    const slot = await RackSlot.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!slot) return next(createError(404, 'Rack slot not found', null, 'NOT_FOUND'))

    if (!['AVAILABLE', 'RESERVED'].includes(slot.status)) {
      return next(createError(409, `Cannot assign a slot that is ${slot.status}`, null, 'RACK_SLOT_INVALID_STATUS'))
    }
    if (Array.isArray(slot.allowedItemTypes) && slot.allowedItemTypes.length && !slot.allowedItemTypes.includes(itemType)) {
      return next(createError(422, `This slot does not accept ${itemType}`, null, 'RACK_SLOT_ITEM_TYPE_MISMATCH'))
    }

    const fromStatus = slot.status
    slot.status = 'OCCUPIED'
    slot.currentItemType = itemType
    slot.currentItemRef = itemRef
    slot.occupiedAt = new Date()
    await slot.save()

    await RackSlotMovement.create({
      organizationId: req.staffUser.organizationId,
      slotId: slot._id,
      fromStatus,
      toStatus: 'OCCUPIED',
      itemType,
      itemRef,
      actorUserId: req.staffUser._id,
      deviceId: req.device._id,
      locationId: slot.locationId,
      shiftInstanceId: req.shiftInstance?._id,
      reason,
    })

    await auditLog.record(req, {
      action: 'RACK_SLOT_ASSIGNED', entityType: 'RackSlot', entityId: slot._id,
      oldValue: { status: fromStatus },
      newValue: { status: 'OCCUPIED', itemType, itemRef },
      locationId: slot.locationId, shiftInstanceId: req.shiftInstance?._id,
    })

    res.json({ success: true, message: 'Rack slot assigned', data: { slot } })
  } catch (err) {
    next(err)
  }
}

const releaseSlot = async (req, res, next) => {
  try {
    const { reason } = req.body
    const slot = await RackSlot.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!slot) return next(createError(404, 'Rack slot not found', null, 'NOT_FOUND'))

    if (slot.status !== 'OCCUPIED') {
      return next(createError(409, `Cannot release a slot that is ${slot.status}`, null, 'RACK_SLOT_INVALID_STATUS'))
    }

    const { currentItemType: itemType, currentItemRef: itemRef } = slot
    slot.status = 'AVAILABLE'
    slot.currentItemType = null
    slot.currentItemRef = null
    slot.occupiedAt = null
    await slot.save()

    await RackSlotMovement.create({
      organizationId: req.staffUser.organizationId,
      slotId: slot._id,
      fromStatus: 'OCCUPIED',
      toStatus: 'AVAILABLE',
      itemType,
      itemRef,
      actorUserId: req.staffUser._id,
      deviceId: req.device._id,
      locationId: slot.locationId,
      shiftInstanceId: req.shiftInstance?._id,
      reason,
    })

    await auditLog.record(req, {
      action: 'RACK_SLOT_RELEASED', entityType: 'RackSlot', entityId: slot._id,
      oldValue: { status: 'OCCUPIED', itemType, itemRef },
      newValue: { status: 'AVAILABLE' },
      locationId: slot.locationId, shiftInstanceId: req.shiftInstance?._id,
    })

    res.json({ success: true, message: 'Rack slot released', data: { slot } })
  } catch (err) {
    next(err)
  }
}

// PATCH /rack-slots/:id/status — Manager+ manual override (maintenance/
// blocked/reserved), same "administrative, no shift required" tier as
// token.controller.js's markTokenStatus.
const updateSlotStatus = async (req, res, next) => {
  try {
    const { status, reason } = req.body
    const slot = await RackSlot.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!slot) return next(createError(404, 'Rack slot not found', null, 'NOT_FOUND'))

    rackSlotStateMachine.assertTransition(slot.status, status, { reason })

    const fromStatus = slot.status
    slot.status = status
    await slot.save()

    await RackSlotMovement.create({
      organizationId: req.staffUser.organizationId,
      slotId: slot._id,
      fromStatus,
      toStatus: status,
      actorUserId: req.staffUser._id,
      deviceId: req.device._id,
      locationId: slot.locationId,
      reason,
    })

    await auditLog.record(req, {
      action: 'RACK_SLOT_STATUS_CHANGED', entityType: 'RackSlot', entityId: slot._id,
      oldValue: { status: fromStatus }, newValue: { status, reason }, locationId: slot.locationId,
    })

    res.json({ success: true, message: 'Rack slot status updated', data: { slot } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listRacks, createRack, updateRack, listSlots, createSlots, suggestRackSlot, assignSlot, releaseSlot, updateSlotStatus }
