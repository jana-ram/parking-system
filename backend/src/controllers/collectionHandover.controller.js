const CollectionHandover = require('../models/CollectionHandover')
const ShiftInstance = require('../models/ShiftInstance')
const collectionHandoverService = require('../services/collectionHandover.service')
const { createError } = require('../utils/helpers')

const loadHandover = async (req, res, next) => {
  try {
    const orgMatch = { organizationId: req.staffUser.organizationId }
    const handover = await CollectionHandover.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
      .populate({ path: 'staffId', select: 'name role', match: orgMatch })
      .populate({ path: 'receivedByStaffId', select: 'name role', match: orgMatch })
      .populate({ path: 'locationId', select: 'name', match: orgMatch })
    if (!handover) return next(createError(404, 'Collection handover not found', null, 'NOT_FOUND'))
    req.collectionHandover = handover
    next()
  } catch (err) {
    next(err)
  }
}

/**
 * POST /collection-handovers — the outgoing staff member (or a Manager+
 * acting on their behalf) claims an amount handed over in person; ownership
 * mirrors closeShift's own-shift-only rule (shift.controller.js).
 */
const initiate = async (req, res, next) => {
  try {
    const { shiftInstanceId, amountMinor, notes } = req.body
    const shiftInstance = await ShiftInstance.findOne({ _id: shiftInstanceId, organizationId: req.staffUser.organizationId })
    if (!shiftInstance) return next(createError(404, 'Shift not found', null, 'NOT_FOUND'))

    const isOwner = String(shiftInstance.staffId) === String(req.staffUser._id)
    const isManagerPlus = ['MANAGER', 'ORG_ADMIN'].includes(req.staffUser.role)
    if (!isOwner && !isManagerPlus) {
      return next(createError(403, 'Only the staff member who worked this shift, a Manager, or an Org Admin can hand over its cash', null, 'FORBIDDEN_ROLE'))
    }

    const handover = await collectionHandoverService.initiateCollectionHandover({
      organizationId: req.staffUser.organizationId, actorStaffUser: req.staffUser, shiftInstance, amountMinor, notes,
    })
    res.status(201).json({ success: true, message: 'Collection handover submitted', data: { collectionHandover: handover } })
  } catch (err) {
    next(err)
  }
}

/**
 * GET /collection-handovers — STAFF only ever sees their own claims; Manager+
 * sees the org's (optionally filtered), matching the RBAC shape reportAPI
 * already uses for revenue visibility (report.routes.js).
 */
const list = async (req, res, next) => {
  try {
    const isManagerPlus = ['MANAGER', 'ORG_ADMIN'].includes(req.staffUser.role)
    const filter = { organizationId: req.staffUser.organizationId }
    if (!isManagerPlus) {
      filter.staffId = req.staffUser._id
    } else if (req.query.staffId) {
      filter.staffId = req.query.staffId
    }
    if (req.query.status) filter.status = req.query.status
    if (req.query.locationId) filter.locationId = req.query.locationId

    const orgMatch = { organizationId: req.staffUser.organizationId }
    const handovers = await CollectionHandover.find(filter)
      .populate({ path: 'staffId', select: 'name role', match: orgMatch })
      .populate({ path: 'receivedByStaffId', select: 'name role', match: orgMatch })
      .populate({ path: 'locationId', select: 'name', match: orgMatch })
      .sort({ createdAt: -1 })
      .limit(200)
    res.json({ success: true, message: 'ok', data: { collectionHandovers: handovers } })
  } catch (err) {
    next(err)
  }
}

const get = async (req, res, next) => {
  try {
    const isManagerPlus = ['MANAGER', 'ORG_ADMIN'].includes(req.staffUser.role)
    if (!isManagerPlus && String(req.collectionHandover.staffId) !== String(req.staffUser._id)) {
      return next(createError(403, 'Not authorized to view this collection handover', null, 'FORBIDDEN_ROLE'))
    }
    res.json({ success: true, message: 'ok', data: { collectionHandover: req.collectionHandover } })
  } catch (err) {
    next(err)
  }
}

const confirm = async (req, res, next) => {
  try {
    const { receivedAmountMinor, notes } = req.body
    const handover = await collectionHandoverService.confirmCollectionHandover({
      organizationId: req.staffUser.organizationId, actorStaffUser: req.staffUser,
      handover: req.collectionHandover, receivedAmountMinor, notes,
    })
    res.json({ success: true, message: 'Collection handover confirmed', data: { collectionHandover: handover } })
  } catch (err) {
    next(err)
  }
}

const reject = async (req, res, next) => {
  try {
    const { reason } = req.body
    const handover = await collectionHandoverService.rejectCollectionHandover({
      organizationId: req.staffUser.organizationId, actorStaffUser: req.staffUser,
      handover: req.collectionHandover, reason,
    })
    res.json({ success: true, message: 'Collection handover rejected', data: { collectionHandover: handover } })
  } catch (err) {
    next(err)
  }
}

module.exports = { loadHandover, initiate, list, get, confirm, reject }
