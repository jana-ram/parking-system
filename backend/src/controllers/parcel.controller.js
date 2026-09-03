const ParcelOrder = require('../models/ParcelOrder')
const ParcelItem = require('../models/ParcelItem')
const Location = require('../models/Location')
const parcelService = require('../services/parcel.service')
const rackSlotService = require('../services/rackSlot.service')
const auditLog = require('../services/auditLog.service')
const { createError, generateEntityCode } = require('../utils/helpers')

// §21/§38 "overdue items are detected" — same computed-on-read convention
// as luggage.controller.js's withOverdueFlag, not a stored/cron-flipped status.
function withOverdueFlag(orderDoc) {
  const order = orderDoc.toObject ? orderDoc.toObject() : orderDoc
  const isOverdue = order.status === 'ACTIVE' && !!order.expectedPickupAt && new Date(order.expectedPickupAt) < new Date()
  return { ...order, isOverdue }
}

const listOrders = async (req, res, next) => {
  try {
    const filter = { organizationId: req.staffUser.organizationId }
    if (req.query.status) filter.status = req.query.status
    if (req.query.locationId) filter.locationId = req.query.locationId
    const orders = (await ParcelOrder.find(filter).sort({ createdAt: -1 }).limit(500)).map(withOverdueFlag)
    const result = req.query.overdueOnly === 'true' ? orders.filter((o) => o.isOverdue) : orders
    res.json({ success: true, message: 'ok', data: { orders: result } })
  } catch (err) {
    next(err)
  }
}

const getOrder = async (req, res, next) => {
  try {
    const orderDoc = await ParcelOrder.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!orderDoc) return next(createError(404, 'Parcel order not found', null, 'NOT_FOUND'))
    const items = await ParcelItem.find({ organizationId: req.staffUser.organizationId, orderId: orderDoc._id }).sort({ createdAt: 1 })
    res.json({ success: true, message: 'ok', data: { order: withOverdueFlag(orderDoc), items } })
  } catch (err) {
    next(err)
  }
}

// GET /parcel-orders/by-code/:orderCode — see luggage.controller.js's
// getOrderByCode for why this exists (the scan-driven pickup flow).
const getOrderByCode = async (req, res, next) => {
  try {
    const orderDoc = await ParcelOrder.findOne({ orderCode: req.params.orderCode.trim(), organizationId: req.staffUser.organizationId })
    if (!orderDoc) return next(createError(404, 'No parcel order found for this code', null, 'NOT_FOUND'))
    const items = await ParcelItem.find({ organizationId: req.staffUser.organizationId, orderId: orderDoc._id }).sort({ createdAt: 1 })
    res.json({ success: true, message: 'ok', data: { order: withOverdueFlag(orderDoc), items } })
  } catch (err) {
    next(err)
  }
}

const createOrder = async (req, res, next) => {
  try {
    const { locationId, senderName, senderPhone, receiverName, receiverPhone, ratePerDayMinor, expectedPickupAt, notes } = req.body
    const location = await Location.findOne({ _id: locationId, organizationId: req.staffUser.organizationId })
    if (!location) return next(createError(404, 'Location not found', null, 'NOT_FOUND'))

    const order = await ParcelOrder.create({
      organizationId: req.staffUser.organizationId, locationId, senderName, senderPhone, receiverName, receiverPhone,
      ratePerDayMinor, currency: location.currency, expectedPickupAt, notes,
      orderCode: generateEntityCode('PAR-ORD'),
      createdByStaffId: req.staffUser._id, shiftInstanceId: req.shiftInstance._id, deviceId: req.device._id,
    })

    await auditLog.record(req, {
      action: 'PARCEL_ORDER_CREATED', entityType: 'ParcelOrder', entityId: order._id,
      newValue: { receiverName, receiverPhone, ratePerDayMinor }, locationId, shiftInstanceId: req.shiftInstance._id,
    })

    res.status(201).json({ success: true, message: 'Parcel order created', data: { order } })
  } catch (err) {
    next(err)
  }
}

const addItems = async (req, res, next) => {
  try {
    const order = await ParcelOrder.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!order) return next(createError(404, 'Parcel order not found', null, 'NOT_FOUND'))
    if (order.status !== 'ACTIVE') return next(createError(409, `Cannot add items to a ${order.status} order`, null, 'VALIDATION_ERROR'))

    const docs = req.body.items.map((item) => ({
      ...item,
      organizationId: req.staffUser.organizationId,
      orderId: order._id,
      locationId: order.locationId,
      itemCode: generateEntityCode('PAR'),
    }))
    const items = await ParcelItem.insertMany(docs, { ordered: false })

    await auditLog.record(req, {
      action: 'PARCEL_ITEMS_ADDED', entityType: 'ParcelOrder', entityId: order._id,
      newValue: { count: items.length }, locationId: order.locationId, shiftInstanceId: req.shiftInstance?._id,
    })

    res.status(201).json({ success: true, message: 'Items added', data: { items } })
  } catch (err) {
    next(err)
  }
}

const assignItemRack = async (req, res, next) => {
  try {
    const { rackSlotId, reason } = req.body
    const item = await ParcelItem.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!item) return next(createError(404, 'Parcel item not found', null, 'NOT_FOUND'))
    if (item.status !== 'RECEIVED') return next(createError(409, `Cannot assign a rack to a ${item.status} item`, null, 'VALIDATION_ERROR'))
    if (item.rackSlotId) return next(createError(409, 'This item already has a rack slot assigned — release it first', null, 'VALIDATION_ERROR'))

    await rackSlotService.occupySlot({
      slotId: rackSlotId, organizationId: req.staffUser.organizationId, itemType: 'PARCEL', itemRef: item._id.toString(),
      actorUserId: req.staffUser._id, actorRole: req.staffUser.role, actorName: req.staffUser.name,
      deviceId: req.device._id, shiftInstanceId: req.shiftInstance?._id, reason,
    })

    item.rackSlotId = rackSlotId
    await item.save()

    res.json({ success: true, message: 'Rack slot assigned to item', data: { item } })
  } catch (err) {
    next(err)
  }
}

const releaseItemRack = async (req, res, next) => {
  try {
    const { reason } = req.body
    const item = await ParcelItem.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!item) return next(createError(404, 'Parcel item not found', null, 'NOT_FOUND'))
    if (!item.rackSlotId) return next(createError(409, 'This item has no rack slot assigned', null, 'VALIDATION_ERROR'))

    await rackSlotService.vacateSlot({
      slotId: item.rackSlotId, organizationId: req.staffUser.organizationId,
      actorUserId: req.staffUser._id, actorRole: req.staffUser.role, actorName: req.staffUser.name,
      deviceId: req.device._id, shiftInstanceId: req.shiftInstance?._id, reason,
    })

    item.rackSlotId = null
    await item.save()

    res.json({ success: true, message: 'Rack slot released from item', data: { item } })
  } catch (err) {
    next(err)
  }
}

const overrideAmount = async (req, res, next) => {
  try {
    const order = await parcelService.overrideAmount({
      organizationId: req.staffUser.organizationId, orderId: req.params.id,
      manualAmountMinor: req.body.manualAmountMinor, reason: req.body.reason,
      staffUser: req.staffUser, device: req.device, shiftInstance: req.shiftInstance,
    })
    res.json({ success: true, message: 'Amount overridden', data: { order } })
  } catch (err) {
    next(err)
  }
}

const recordPayment = async (req, res, next) => {
  try {
    const { method, amountMinor, clientTransactionId } = req.body
    const { order, payment } = await parcelService.recordPayment({
      organizationId: req.staffUser.organizationId, orderId: req.params.id, method, amountMinor, clientTransactionId,
      staffUser: req.staffUser, device: req.device, shiftInstance: req.shiftInstance,
    })
    res.status(201).json({ success: true, message: 'Payment recorded', data: { order, payment } })
  } catch (err) {
    next(err)
  }
}

const pickup = async (req, res, next) => {
  try {
    const order = await parcelService.pickup({
      organizationId: req.staffUser.organizationId, orderId: req.params.id,
      staffUser: req.staffUser, device: req.device, shiftInstance: req.shiftInstance,
    })
    res.json({ success: true, message: 'Parcel collected', data: { order } })
  } catch (err) {
    next(err)
  }
}

const cancelOrder = async (req, res, next) => {
  try {
    const order = await parcelService.cancelOrder({
      organizationId: req.staffUser.organizationId, orderId: req.params.id, reason: req.body.reason,
      staffUser: req.staffUser, device: req.device,
    })
    res.json({ success: true, message: 'Parcel order cancelled', data: { order } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listOrders, getOrder, getOrderByCode, createOrder, addItems, assignItemRack, releaseItemRack, overrideAmount, recordPayment, pickup, cancelOrder }
