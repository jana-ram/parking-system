const LuggageOrder = require('../models/LuggageOrder')
const LuggageItem = require('../models/LuggageItem')
const Location = require('../models/Location')
const ItemPricingRule = require('../models/ItemPricingRule')
const luggageService = require('../services/luggage.service')
const rackSlotService = require('../services/rackSlot.service')
const auditLog = require('../services/auditLog.service')
const { createError, generateEntityCode } = require('../utils/helpers')

// §21/§38 "overdue items are detected" — computed on read, not a stored/
// cron-flipped status: an ACTIVE order past its expectedPickupAt is overdue
// right now, by definition, so there's nothing a background sweep would add
// except staleness risk. No expectedPickupAt means "not tracked," not overdue.
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
    const orders = (await LuggageOrder.find(filter).sort({ createdAt: -1 }).limit(500)).map(withOverdueFlag)
    const result = req.query.overdueOnly === 'true' ? orders.filter((o) => o.isOverdue) : orders
    res.json({ success: true, message: 'ok', data: { orders: result } })
  } catch (err) {
    next(err)
  }
}

const getOrder = async (req, res, next) => {
  try {
    const orderDoc = await LuggageOrder.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!orderDoc) return next(createError(404, 'Luggage order not found', null, 'NOT_FOUND'))
    const items = await LuggageItem.find({ organizationId: req.staffUser.organizationId, orderId: orderDoc._id }).sort({ createdAt: 1 })
    res.json({ success: true, message: 'ok', data: { order: withOverdueFlag(orderDoc), items } })
  } catch (err) {
    next(err)
  }
}

// GET /luggage-orders/by-code/:orderCode — the scan-driven pickup flow's
// lookup, same "scan/enter a code, resolve straight to the record" shape as
// session.controller.js's findSessionByTokenCode. Lets staff go from a
// scanned/typed claim code straight to the pickup screen in one step,
// instead of browsing the order list.
const getOrderByCode = async (req, res, next) => {
  try {
    const orderDoc = await LuggageOrder.findOne({ orderCode: req.params.orderCode.trim(), organizationId: req.staffUser.organizationId })
    if (!orderDoc) return next(createError(404, 'No luggage order found for this code', null, 'NOT_FOUND'))
    const items = await LuggageItem.find({ organizationId: req.staffUser.organizationId, orderId: orderDoc._id }).sort({ createdAt: 1 })
    res.json({ success: true, message: 'ok', data: { order: withOverdueFlag(orderDoc), items } })
  } catch (err) {
    next(err)
  }
}

// POST /luggage-orders — an operational, counter-side write bound to an
// active shift, same tier as session entry.
// §2: either resolve pricingRuleId into a rate/unit/maxDays (the fast
// path — staff pick a rule instead of typing a number), or fall back to a
// manually-typed ratePerDayMinor exactly as before, so check-in is never
// blocked by a missing/misconfigured rule. Whichever wins is snapshotted
// onto the order — see LuggageOrder.js's header for why.
const createOrder = async (req, res, next) => {
  try {
    const { locationId, customerName, customerPhone, pricingRuleId, ratePerDayMinor, expectedPickupAt, notes } = req.body
    const location = await Location.findOne({ _id: locationId, organizationId: req.staffUser.organizationId })
    if (!location) return next(createError(404, 'Location not found', null, 'NOT_FOUND'))

    let resolvedRateMinor = ratePerDayMinor
    let pricingUnit = 'DAY'
    let maxDays = null
    if (pricingRuleId) {
      const rule = await ItemPricingRule.findOne({ _id: pricingRuleId, organizationId: req.staffUser.organizationId, module: 'LUGGAGE', status: 'ACTIVE' })
      if (!rule) return next(createError(404, 'Pricing rule not found or inactive', null, 'NOT_FOUND'))
      resolvedRateMinor = rule.rateMinor
      pricingUnit = rule.unit
      maxDays = rule.maxDays
    }
    if (resolvedRateMinor == null) return next(createError(422, 'Either pricingRuleId or ratePerDayMinor is required', null, 'VALIDATION_ERROR'))

    const order = await LuggageOrder.create({
      organizationId: req.staffUser.organizationId, locationId, customerName, customerPhone,
      ratePerDayMinor: resolvedRateMinor, pricingUnit, maxDays,
      currency: location.currency, expectedPickupAt, notes,
      orderCode: generateEntityCode('LUG-ORD'),
      createdByStaffId: req.staffUser._id, shiftInstanceId: req.shiftInstance._id, deviceId: req.device._id,
    })

    await auditLog.record(req, {
      action: 'LUGGAGE_ORDER_CREATED', entityType: 'LuggageOrder', entityId: order._id,
      newValue: { customerName, customerPhone, ratePerDayMinor: resolvedRateMinor, pricingUnit }, locationId, shiftInstanceId: req.shiftInstance._id,
    })

    res.status(201).json({ success: true, message: 'Luggage order created', data: { order } })
  } catch (err) {
    next(err)
  }
}

const addItems = async (req, res, next) => {
  try {
    const order = await LuggageOrder.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!order) return next(createError(404, 'Luggage order not found', null, 'NOT_FOUND'))
    if (order.status !== 'ACTIVE') return next(createError(409, `Cannot add items to a ${order.status} order`, null, 'VALIDATION_ERROR'))

    const docs = req.body.items.map((item) => ({
      ...item,
      organizationId: req.staffUser.organizationId,
      orderId: order._id,
      locationId: order.locationId,
      itemCode: generateEntityCode('LUG'),
    }))
    const items = await LuggageItem.insertMany(docs, { ordered: false })

    await auditLog.record(req, {
      action: 'LUGGAGE_ITEMS_ADDED', entityType: 'LuggageOrder', entityId: order._id,
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
    const item = await LuggageItem.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!item) return next(createError(404, 'Luggage item not found', null, 'NOT_FOUND'))
    if (item.status !== 'CHECKED_IN') return next(createError(409, `Cannot assign a rack to a ${item.status} item`, null, 'VALIDATION_ERROR'))
    if (item.rackSlotId) return next(createError(409, 'This item already has a rack slot assigned — release it first', null, 'VALIDATION_ERROR'))

    await rackSlotService.occupySlot({
      slotId: rackSlotId, organizationId: req.staffUser.organizationId, itemType: 'LUGGAGE', itemRef: item._id.toString(),
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
    const item = await LuggageItem.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!item) return next(createError(404, 'Luggage item not found', null, 'NOT_FOUND'))
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
    const order = await luggageService.overrideAmount({
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
    const { order, payment } = await luggageService.recordPayment({
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
    const order = await luggageService.pickup({
      organizationId: req.staffUser.organizationId, orderId: req.params.id,
      staffUser: req.staffUser, device: req.device, shiftInstance: req.shiftInstance,
    })
    res.json({ success: true, message: 'Luggage picked up', data: { order } })
  } catch (err) {
    next(err)
  }
}

const cancelOrder = async (req, res, next) => {
  try {
    const order = await luggageService.cancelOrder({
      organizationId: req.staffUser.organizationId, orderId: req.params.id, reason: req.body.reason,
      staffUser: req.staffUser, device: req.device,
    })
    res.json({ success: true, message: 'Luggage order cancelled', data: { order } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listOrders, getOrder, getOrderByCode, createOrder, addItems, assignItemRack, releaseItemRack, overrideAmount, recordPayment, pickup, cancelOrder }
