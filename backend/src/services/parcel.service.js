/**
 * parcel.service.js — the payment/pickup/cancel business logic for
 * ParcelOrder, structurally identical to luggage.service.js. Reuses
 * domain/luggagePricing.js's flat-per-day-rate math directly (domain-
 * agnostic despite the file name) rather than duplicating it — adapts at
 * the call site since ParcelOrder's field is `receivedAt`, not `checkInAt`.
 */
const ParcelOrder = require('../models/ParcelOrder')
const ParcelItem = require('../models/ParcelItem')
const ParcelPayment = require('../models/ParcelPayment')
const rackSlotService = require('./rackSlot.service')
const luggagePricing = require('../domain/luggagePricing')
const auditLog = require('./auditLog.service')
const correctionService = require('./correction.service')
const { createError } = require('../utils/helpers')

// §12 — a manual-amount override (once set) is a fixed figure, not
// something later payment/pickup calls recompute out from under it.
function computeAmountDueMinor(order, referenceAt = new Date()) {
  if (order.manualAmountOverrideMinor != null) return order.manualAmountOverrideMinor
  return luggagePricing.computeAmountDueMinor({ checkInAt: order.receivedAt, ratePerDayMinor: order.ratePerDayMinor }, referenceAt)
}

async function overrideAmount({ organizationId, orderId, manualAmountMinor, reason, staffUser, device, shiftInstance }) {
  const order = await ParcelOrder.findOne({ _id: orderId, organizationId })
  if (!order) throw createError(404, 'Parcel order not found', null, 'NOT_FOUND')
  if (order.status !== 'ACTIVE') throw createError(409, `Cannot override the amount on a ${order.status} order`, null, 'VALIDATION_ERROR')

  const oldValue = computeAmountDueMinor(order)
  order.manualAmountOverrideMinor = manualAmountMinor
  order.amountDueMinor = manualAmountMinor
  await order.save()

  await correctionService.applyCorrection({
    organizationId, entityType: 'ParcelOrder', entityId: order._id, field: 'amountDueMinor',
    oldValue, newValue: manualAmountMinor, reason, staffUser,
    deviceId: device._id, locationId: order.locationId, shiftInstanceId: shiftInstance?._id,
  })

  return order
}

async function recordPayment({ organizationId, orderId, method, amountMinor, clientTransactionId, staffUser, device, shiftInstance }) {
  const order = await ParcelOrder.findOne({ _id: orderId, organizationId })
  if (!order) throw createError(404, 'Parcel order not found', null, 'NOT_FOUND')
  if (order.status !== 'ACTIVE') throw createError(409, `Cannot record payment on a ${order.status} order`, null, 'VALIDATION_ERROR')
  if (amountMinor <= 0) throw createError(422, 'amountMinor must be positive', null, 'VALIDATION_ERROR')

  const payment = await ParcelPayment.create({
    organizationId, orderId, locationId: order.locationId, method, amountMinor, currency: order.currency,
    recordedBy: staffUser._id, shiftInstanceId: shiftInstance._id, deviceId: device._id, clientTransactionId,
  })

  order.amountDueMinor = computeAmountDueMinor(order)
  order.amountPaidMinor += amountMinor
  await order.save()

  await auditLog.recordSystem({
    organizationId, actorId: staffUser._id, actorRole: staffUser.role, actorName: staffUser.name,
    action: 'PARCEL_PAYMENT_RECORDED', entityType: 'ParcelOrder', entityId: order._id,
    newValue: { method, amountMinor }, deviceId: device._id, locationId: order.locationId, shiftInstanceId: shiftInstance._id,
  })

  return { order, payment }
}

async function pickup({ organizationId, orderId, staffUser, device, shiftInstance }) {
  const order = await ParcelOrder.findOne({ _id: orderId, organizationId })
  if (!order) throw createError(404, 'Parcel order not found', null, 'NOT_FOUND')
  if (order.status !== 'ACTIVE') throw createError(409, `Cannot pick up a ${order.status} order`, null, 'VALIDATION_ERROR')

  const dueNow = computeAmountDueMinor(order)
  if (order.amountPaidMinor < dueNow) {
    const shortfall = ((dueNow - order.amountPaidMinor) / 100).toFixed(2)
    throw createError(402, `₹${shortfall} is still due before pickup`, null, 'PAYMENT_PENDING')
  }

  const items = await ParcelItem.find({ organizationId, orderId: order._id, status: 'RECEIVED' })
  for (const item of items) {
    if (item.rackSlotId) {
      await rackSlotService.vacateSlot({
        slotId: item.rackSlotId, organizationId, actorUserId: staffUser._id, actorRole: staffUser.role,
        actorName: staffUser.name, deviceId: device._id, shiftInstanceId: shiftInstance._id, reason: 'Parcel collected',
      })
    }
    item.status = 'COLLECTED'
    item.collectedAt = new Date()
    item.rackSlotId = null
    await item.save()
  }

  order.status = 'COMPLETED'
  order.actualPickupAt = new Date()
  order.amountDueMinor = dueNow
  await order.save()

  await auditLog.recordSystem({
    organizationId, actorId: staffUser._id, actorRole: staffUser.role, actorName: staffUser.name,
    action: 'PARCEL_ORDER_COMPLETED', entityType: 'ParcelOrder', entityId: order._id,
    newValue: { amountDueMinor: dueNow, amountPaidMinor: order.amountPaidMinor },
    deviceId: device._id, locationId: order.locationId, shiftInstanceId: shiftInstance._id,
  })

  return order
}

async function cancelOrder({ organizationId, orderId, reason, staffUser, device }) {
  const order = await ParcelOrder.findOne({ _id: orderId, organizationId })
  if (!order) throw createError(404, 'Parcel order not found', null, 'NOT_FOUND')
  if (order.status !== 'ACTIVE') throw createError(409, `Cannot cancel a ${order.status} order`, null, 'VALIDATION_ERROR')
  if (order.amountPaidMinor > 0) {
    throw createError(409, 'This order already has a payment recorded — it cannot be cancelled without a refund', null, 'VALIDATION_ERROR')
  }

  const items = await ParcelItem.find({ organizationId, orderId: order._id, status: 'RECEIVED' })
  for (const item of items) {
    if (item.rackSlotId) {
      await rackSlotService.vacateSlot({
        slotId: item.rackSlotId, organizationId, actorUserId: staffUser._id, actorRole: staffUser.role,
        actorName: staffUser.name, deviceId: device._id, reason: 'Parcel order cancelled',
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
    action: 'PARCEL_ORDER_CANCELLED', entityType: 'ParcelOrder', entityId: order._id,
    newValue: { reason }, deviceId: device._id, locationId: order.locationId,
  })

  return order
}

module.exports = { computeAmountDueMinor, overrideAmount, recordPayment, pickup, cancelOrder }
