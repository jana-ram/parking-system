/**
 * luggage.service.js — the payment/pickup/cancel business logic for
 * LuggageOrder, kept out of the controller the same way session.service.js
 * keeps ParkingSession's equivalent logic out of session.controller.js.
 */
const LuggageOrder = require('../models/LuggageOrder')
const LuggageItem = require('../models/LuggageItem')
const LuggagePayment = require('../models/LuggagePayment')
const rackSlotService = require('./rackSlot.service')
const luggagePricing = require('../domain/luggagePricing')
const auditLog = require('./auditLog.service')
const correctionService = require('./correction.service')
const { createError } = require('../utils/helpers')

// §12 — a manual-amount override (once set) is a fixed figure, not
// something later payment/pickup calls recompute out from under it.
function computeAmountDueMinor(order, referenceAt) {
  if (order.manualAmountOverrideMinor != null) return order.manualAmountOverrideMinor
  return luggagePricing.computeAmountDueMinor(order, referenceAt)
}

async function overrideAmount({ organizationId, orderId, manualAmountMinor, reason, staffUser, device, shiftInstance }) {
  const order = await LuggageOrder.findOne({ _id: orderId, organizationId })
  if (!order) throw createError(404, 'Luggage order not found', null, 'NOT_FOUND')
  if (order.status !== 'ACTIVE') throw createError(409, `Cannot override the amount on a ${order.status} order`, null, 'VALIDATION_ERROR')

  const oldValue = computeAmountDueMinor(order)
  order.manualAmountOverrideMinor = manualAmountMinor
  order.amountDueMinor = manualAmountMinor
  await order.save()

  await correctionService.applyCorrection({
    organizationId, entityType: 'LuggageOrder', entityId: order._id, field: 'amountDueMinor',
    oldValue, newValue: manualAmountMinor, reason, staffUser,
    deviceId: device._id, locationId: order.locationId, shiftInstanceId: shiftInstance?._id,
  })

  return order
}

async function recordPayment({ organizationId, orderId, method, amountMinor, clientTransactionId, staffUser, device, shiftInstance }) {
  const order = await LuggageOrder.findOne({ _id: orderId, organizationId })
  if (!order) throw createError(404, 'Luggage order not found', null, 'NOT_FOUND')
  if (order.status !== 'ACTIVE') throw createError(409, `Cannot record payment on a ${order.status} order`, null, 'VALIDATION_ERROR')
  if (amountMinor <= 0) throw createError(422, 'amountMinor must be positive', null, 'VALIDATION_ERROR')

  const payment = await LuggagePayment.create({
    organizationId, orderId, locationId: order.locationId, method, amountMinor, currency: order.currency,
    recordedBy: staffUser._id, shiftInstanceId: shiftInstance._id, deviceId: device._id, clientTransactionId,
  })

  order.amountDueMinor = computeAmountDueMinor(order)
  order.amountPaidMinor += amountMinor
  await order.save()

  await auditLog.recordSystem({
    organizationId, actorId: staffUser._id, actorRole: staffUser.role, actorName: staffUser.name,
    action: 'LUGGAGE_PAYMENT_RECORDED', entityType: 'LuggageOrder', entityId: order._id,
    newValue: { method, amountMinor }, deviceId: device._id, locationId: order.locationId, shiftInstanceId: shiftInstance._id,
  })

  return { order, payment }
}

async function pickup({ organizationId, orderId, staffUser, device, shiftInstance }) {
  const order = await LuggageOrder.findOne({ _id: orderId, organizationId })
  if (!order) throw createError(404, 'Luggage order not found', null, 'NOT_FOUND')
  if (order.status !== 'ACTIVE') throw createError(409, `Cannot pick up a ${order.status} order`, null, 'VALIDATION_ERROR')

  const dueNow = computeAmountDueMinor(order)
  if (order.amountPaidMinor < dueNow) {
    const shortfall = ((dueNow - order.amountPaidMinor) / 100).toFixed(2)
    throw createError(402, `₹${shortfall} is still due before pickup`, null, 'PAYMENT_PENDING')
  }

  const items = await LuggageItem.find({ organizationId, orderId: order._id, status: 'CHECKED_IN' })
  for (const item of items) {
    if (item.rackSlotId) {
      await rackSlotService.vacateSlot({
        slotId: item.rackSlotId, organizationId, actorUserId: staffUser._id, actorRole: staffUser.role,
        actorName: staffUser.name, deviceId: device._id, shiftInstanceId: shiftInstance._id, reason: 'Luggage picked up',
      })
    }
    item.status = 'PICKED_UP'
    item.pickedUpAt = new Date()
    item.rackSlotId = null
    await item.save()
  }

  order.status = 'COMPLETED'
  order.actualPickupAt = new Date()
  order.amountDueMinor = dueNow
  await order.save()

  await auditLog.recordSystem({
    organizationId, actorId: staffUser._id, actorRole: staffUser.role, actorName: staffUser.name,
    action: 'LUGGAGE_ORDER_COMPLETED', entityType: 'LuggageOrder', entityId: order._id,
    newValue: { amountDueMinor: dueNow, amountPaidMinor: order.amountPaidMinor },
    deviceId: device._id, locationId: order.locationId, shiftInstanceId: shiftInstance._id,
  })

  return order
}

async function cancelOrder({ organizationId, orderId, reason, staffUser, device }) {
  const order = await LuggageOrder.findOne({ _id: orderId, organizationId })
  if (!order) throw createError(404, 'Luggage order not found', null, 'NOT_FOUND')
  if (order.status !== 'ACTIVE') throw createError(409, `Cannot cancel a ${order.status} order`, null, 'VALIDATION_ERROR')
  // A paid order needs a refund, not a cancel — no refund flow exists yet
  // (Phase 15/16), so block rather than silently strand the collected cash.
  if (order.amountPaidMinor > 0) {
    throw createError(409, 'This order already has a payment recorded — it cannot be cancelled without a refund', null, 'VALIDATION_ERROR')
  }

  const items = await LuggageItem.find({ organizationId, orderId: order._id, status: 'CHECKED_IN' })
  for (const item of items) {
    if (item.rackSlotId) {
      await rackSlotService.vacateSlot({
        slotId: item.rackSlotId, organizationId, actorUserId: staffUser._id, actorRole: staffUser.role,
        actorName: staffUser.name, deviceId: device._id, reason: 'Luggage order cancelled',
      })
    }
    item.status = 'CANCELLED'
    item.rackSlotId = null
    await item.save()
  }

  order.status = 'CANCELLED'
  order.cancelReason = reason
  await order.save()

  await auditLog.recordSystem({
    organizationId, actorId: staffUser._id, actorRole: staffUser.role, actorName: staffUser.name,
    action: 'LUGGAGE_ORDER_CANCELLED', entityType: 'LuggageOrder', entityId: order._id,
    newValue: { reason }, deviceId: device._id, locationId: order.locationId,
  })

  return order
}

module.exports = { computeAmountDueMinor, overrideAmount, recordPayment, pickup, cancelOrder }
