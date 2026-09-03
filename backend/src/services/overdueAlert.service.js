/**
 * overdueAlert.service.js — automatic overdue-pickup detection (unclaimed
 * luggage/parcels are real revenue leakage: storage fees keep accruing but
 * nobody follows up until a customer complains or an audit stumbles on it).
 * Runs periodically from server.js rather than waiting for a human to open
 * the "Overdue only" filter — same "identify automatically, don't rely on a
 * manual check" instinct as the rack auto-assign and scan-first pickup work.
 *
 * Cross-tenant by nature (one sweep covers every org), so it queries with
 * `.setOptions({ skipOrgScope: true })` — the one sanctioned way to bypass
 * requireOrgScope.js, same convention the /platform/* routes use — and scopes
 * every notification it sends back to that order's own organizationId.
 */
const LuggageOrder = require('../models/LuggageOrder')
const ParcelOrder = require('../models/ParcelOrder')
const notificationService = require('./notification.service')
const logger = require('../utils/logger')

function money(minor) {
  return (minor / 100).toFixed(2)
}

async function alertOverdueOrders(Model, kind, describe) {
  const now = new Date()
  const overdue = await Model.find({
    status: 'ACTIVE',
    expectedPickupAt: { $lt: now },
    overdueNotifiedAt: null,
  }).setOptions({ skipOrgScope: true }).limit(500)

  for (const order of overdue) {
    try {
      await notificationService.notifyRoles({
        organizationId: order.organizationId,
        roles: ['MANAGER', 'ORG_ADMIN'],
        type: `${kind}_OVERDUE_PICKUP`,
        severity: 'WARNING',
        title: `${kind === 'LUGGAGE' ? 'Luggage' : 'Parcel'} overdue for pickup`,
        body: `Order ${order.orderCode} (${describe(order)}) is overdue for pickup. Balance so far: ${money(order.amountDueMinor - order.amountPaidMinor)}.`,
        entityRef: { [kind === 'LUGGAGE' ? 'luggageOrderId' : 'parcelOrderId']: order._id },
      })
      order.overdueNotifiedAt = now
      await order.save()
    } catch (err) {
      logger.warn(`overdueAlert: failed to notify for ${kind} order ${order._id}: ${err.message}`)
    }
  }

  return overdue.length
}

async function scanAndNotifyOverdue() {
  const luggageCount = await alertOverdueOrders(LuggageOrder, 'LUGGAGE', (o) => o.customerName)
  const parcelCount = await alertOverdueOrders(ParcelOrder, 'PARCEL', (o) => `to ${o.receiverName}`)
  if (luggageCount || parcelCount) {
    logger.info(`overdueAlert: notified ${luggageCount} luggage + ${parcelCount} parcel order(s)`)
  }
  return { luggageCount, parcelCount }
}

module.exports = { scanAndNotifyOverdue }
