const mongoose = require('mongoose')
const SyncEvent = require('../models/SyncEvent')
const ShiftInstance = require('../models/ShiftInstance')
const QrToken = require('../models/QrToken')
const Incident = require('../models/Incident')
const sessionService = require('./session.service')
const retryPolicy = require('../domain/retryPolicy')
const { classifySyncFailure } = require('../domain/syncConflictPolicy')
const { createError } = require('../utils/helpers')

/**
 * Sync handler dispatch table — keyed `${entityType}:${operation}`.
 *
 * [Phase 5 scope note] Only ParkingSession:CREATE (vehicle entry) is wired
 * through sync in this phase — it's the highest-value, most illustrative
 * case, and every other entity type (Payment, exit-request, ShiftInstance
 * operations) follows the IDENTICAL pattern: look up whatever historical
 * context the payload references (shift, staff, device — all by ID, exactly
 * as captured on-device at the moment of the original action, not "now"),
 * then call the existing service function that already powers the online
 * API. This is a scope limit for this phase, not a design ceiling — adding
 * a new entity type here does not require inventing new sync machinery.
 */
async function applyParkingSessionCreate(payload, ctx) {
  const shiftInstance = await ShiftInstance.findOne({ _id: payload.shiftInstanceId, organizationId: ctx.organizationId })
  if (!shiftInstance) throw createError(404, 'Shift not found for this sync event', null, 'NOT_FOUND')

  const { session } = await sessionService.enterVehicle({
    organizationId: ctx.organizationId,
    staffUser: ctx.staffUser,
    device: ctx.device,
    shiftInstance,
    body: payload,
  })
  return session._id
}

const HANDLERS = {
  'ParkingSession:CREATE': applyParkingSessionCreate,
}

/**
 * processPushBatch — §J.3's server-side push handling, one event per DB
 * transaction (never partial-apply a batch as a unit — a later event
 * failing must not roll back an earlier one that already succeeded).
 *
 * Idempotency (§L): the very first thing checked for every event is whether
 * its clientTransactionId has been seen before; a SYNCED replay short-circuits
 * to the ORIGINAL result without re-running any business logic.
 */
async function processPushBatch({ organizationId, staffUser, device, events }) {
  const results = []

  for (const event of events) {
    const { clientTransactionId, entityType, operation, payload } = event
    const handlerKey = `${entityType}:${operation}`

    let syncEvent = await SyncEvent.findOne({ organizationId, clientTransactionId })

    if (syncEvent && syncEvent.status === 'SYNCED') {
      results.push({ clientTransactionId, status: 'SYNCED', serverVersion: syncEvent.serverVersion })
      continue
    }

    if (syncEvent && syncEvent.status === 'BLOCKED') {
      // Retries exhausted previously and nothing about the event has changed
      // since — don't silently re-attempt something already given up on;
      // that's exactly the "hammer the server forever" behavior §25 forbids.
      results.push({ clientTransactionId, status: 'BLOCKED', code: syncEvent.error?.code, message: syncEvent.error?.message })
      continue
    }

    if (!syncEvent) {
      syncEvent = await SyncEvent.create({
        organizationId, deviceId: device._id, entityType, entityId: new mongoose.Types.ObjectId(),
        clientTransactionId, operation, payload, status: 'SYNCING', retryCount: 0,
      })
    } else {
      syncEvent.status = 'SYNCING'
      syncEvent.lastAttemptAt = new Date()
      await syncEvent.save()
    }

    const handler = HANDLERS[handlerKey]
    if (!handler) {
      syncEvent.status = 'BLOCKED'
      syncEvent.error = { code: 'NO_SYNC_HANDLER', message: `No sync handler registered for ${handlerKey}` }
      await syncEvent.save()
      results.push({ clientTransactionId, status: 'BLOCKED', code: 'NO_SYNC_HANDLER', message: syncEvent.error.message })
      continue
    }

    try {
      // The underlying entity (ParkingSession, etc.) has its OWN
      // clientTransactionId column for its own idempotency guarantee (§L) —
      // the sync envelope's clientTransactionId is the natural value for it,
      // so it's threaded through here rather than requiring every mobile
      // payload to redundantly repeat it inside `payload` itself.
      const entityId = await handler({ ...payload, clientTransactionId }, { organizationId, staffUser, device })
      syncEvent.entityId = entityId
      syncEvent.status = 'SYNCED'
      syncEvent.serverVersion = 1
      await syncEvent.save()
      results.push({ clientTransactionId, status: 'SYNCED', serverVersion: 1 })
    } catch (err) {
      const classification = classifySyncFailure(err)

      if (classification.outcome === 'REJECTED') {
        // §K: the server never guesses — a permanent business-rule loss goes
        // to CONFLICT for a human, not into the retry loop.
        syncEvent.status = 'CONFLICT'
        syncEvent.error = { code: classification.code, message: classification.message }
        await syncEvent.save()
        await Incident.create({
          organizationId, type: 'SYNC_CONFLICT', severity: 'MEDIUM',
          entityType, entityId: syncEvent._id,
          description: `${entityType} sync rejected for device ${device.deviceUuid}: ${classification.message}`,
        })
        results.push({ clientTransactionId, status: 'CONFLICT', code: classification.code, message: classification.message })
        continue
      }

      const { status, nextAttemptAt } = retryPolicy.nextAttempt(syncEvent.retryCount)
      syncEvent.status = status
      syncEvent.retryCount += 1
      syncEvent.nextAttemptAt = nextAttemptAt
      syncEvent.error = { code: classification.code, message: classification.message }
      await syncEvent.save()

      if (status === 'BLOCKED') {
        await Incident.create({
          organizationId, type: 'SYNC_RETRY_EXHAUSTED', severity: 'HIGH',
          entityType, entityId: syncEvent._id,
          description: `${entityType} sync exhausted all retries for device ${device.deviceUuid}: ${classification.message}`,
        })
      }
      results.push({ clientTransactionId, status, code: classification.code, message: classification.message })
    }
  }

  return results
}

/**
 * pull — §J's server -> client leg. [Phase 5 first version, scope note:]
 * returns the token registry for the device's own location (staff need this
 * to scan/validate offline) changed since `since`. Reference-data pull
 * (pricing rules, shift templates) and cross-device session-state pull
 * follow the same shape and are a straightforward next addition, not
 * included here to keep this phase's surface reviewable.
 */
async function pull({ organizationId, device, since }) {
  const filter = { organizationId }
  if (device.locationId) filter.locationId = device.locationId
  if (since) filter.updatedAt = { $gt: new Date(since) }

  const tokens = await QrToken.find(filter).select('tokenCode status locationId currentSessionId updatedAt').limit(1000)
  return { tokens, serverTime: new Date() }
}

module.exports = { processPushBatch, pull, HANDLERS }
