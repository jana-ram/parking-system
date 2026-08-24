const mongoose = require('mongoose')
const ParkingSession = require('../models/ParkingSession')
const Vehicle = require('../models/Vehicle')
const QrToken = require('../models/QrToken')
const TokenMovement = require('../models/TokenMovement')
const ParkingSlot = require('../models/ParkingSlot')
const Payment = require('../models/Payment')
const Location = require('../models/Location')
const PricingRuleVersion = require('../models/PricingRuleVersion')
const sessionStateMachine = require('../domain/sessionStateMachine')
const tokenStateMachine = require('../domain/tokenStateMachine')
const pricingEngine = require('../domain/pricingEngine')
const pricingRuleService = require('./pricingRule.service')
const auditLog = require('./auditLog.service')
const { normalizeVehicleNumber, createError } = require('../utils/helpers')

const ENTRY_PRICED_MODES = ['PAY_ON_ENTRY', 'FIXED_DURATION']

/**
 * Atomically moves a token from fromStatus to toStatus, INSIDE a transaction,
 * using a conditional update (not a blind save on a possibly-stale in-memory
 * doc) so a race between two concurrent requests is resolved by the database,
 * not by whichever request happened to read first (§K). Always paired with a
 * TokenMovement insert in the same transaction (§21 — the movement log is
 * structurally complete, never an afterthought).
 */
async function moveToken({ mongooseSession, organizationId, tokenId, fromStatus, toStatus, sessionId, actorUserId, deviceId, locationId, shiftInstanceId, reason }) {
  tokenStateMachine.assertTransition(fromStatus, toStatus)
  const updated = await QrToken.findOneAndUpdate(
    { _id: tokenId, organizationId, status: fromStatus },
    { status: toStatus, currentSessionId: toStatus === 'AVAILABLE' ? null : sessionId },
    { new: true, session: mongooseSession },
  )
  if (!updated) {
    throw createError(409, 'QR token is already in use', null, 'TOKEN_ALREADY_ACTIVE')
  }
  await TokenMovement.create(
    [{ organizationId, tokenId, fromStatus, toStatus, sessionId, actorUserId, deviceId, locationId, shiftInstanceId, reason }],
    { session: mongooseSession },
  )
  return updated
}

async function occupySlot({ mongooseSession, organizationId, slotId }) {
  if (!slotId) return
  const updated = await ParkingSlot.findOneAndUpdate(
    { _id: slotId, organizationId, status: 'AVAILABLE' },
    { status: 'OCCUPIED' },
    { new: true, session: mongooseSession },
  )
  if (!updated) throw createError(409, 'Parking slot is no longer available', null, 'VALIDATION_ERROR')
}

async function releaseSlot({ mongooseSession, organizationId, slotId }) {
  if (!slotId) return
  await ParkingSlot.updateOne(
    { _id: slotId, organizationId },
    { status: 'AVAILABLE' },
    { session: mongooseSession },
  )
}

/**
 * enterVehicle — §9's flow. Idempotent on clientTransactionId (§L): a retried
 * push of the same entry returns the original result rather than erroring or
 * duplicating. Slot (if any) is occupied at CREATED time, not deferred to
 * ACTIVE, so it can never be double-assigned during the payment window of an
 * entry-priced session.
 *
 * [Phase 3 scope note] Entry-priced sessions always stop at PAYMENT_PENDING
 * here; completing payment is a separate call to recordPayment() below. The
 * original API sketch's `paymentIfEntryMode` same-call shortcut was dropped
 * to keep entry and payment as two single-purpose operations rather than one
 * with two very different shapes depending on mode.
 */
async function enterVehicle({ organizationId, staffUser, device, shiftInstance, body }) {
  const { clientTransactionId, locationId, parkingAreaId, slotId, vehicleNumber: rawVehicleNumber, vehicleTypeId, tokenCode, entryAt } = body

  const existing = await ParkingSession.findOne({ organizationId, clientTransactionId })
  if (existing) return { statusCode: 200, session: existing }

  // Independent reads — run concurrently instead of two sequential round
  // trips (real, measured latency win on this path; found while
  // investigating "parking a vehicle is slow").
  const [location, token] = await Promise.all([
    Location.findOne({ _id: locationId, organizationId }),
    QrToken.findOne({ organizationId, tokenCode }),
  ])
  if (!location) throw createError(404, 'Location not found', null, 'NOT_FOUND')
  if (!token) throw createError(404, 'QR token is not recognized', null, 'TOKEN_INVALID_STATUS')
  if (String(token.locationId) !== String(locationId)) {
    throw createError(409, 'QR token belongs to a different location', null, 'TOKEN_LOCATION_MISMATCH')
  }
  tokenStateMachine.assertTransition(token.status, 'ASSIGNED') // pre-check for a clear error before opening a transaction

  const resolved = await pricingRuleService.resolveActiveRule({ organizationId, locationId, vehicleTypeId })
  if (!resolved) throw createError(422, 'No active pricing rule for this vehicle type at this location', null, 'PRICING_CONFIG_INCOMPLETE')
  const { rule, version } = resolved
  const mode = rule.mode
  const isEntryPriced = ENTRY_PRICED_MODES.includes(mode)
  const amountDueMinor = isEntryPriced ? pricingEngine.calculateEntryAmount(version.config) : null
  // Fixed-entry/no-exit locations (temples etc.): a FIXED_DURATION session at
  // a location with fixedEntryNoExit enabled makes the exit scan optional —
  // read-side UX metadata only, does not change sessionStateMachine at all.
  const exitRequired = !(mode === 'FIXED_DURATION' && location.features?.fixedEntryNoExit?.enabled)

  const vehicleNumber = normalizeVehicleNumber(rawVehicleNumber)
  const entryDate = entryAt ? new Date(entryAt) : new Date()

  const mongooseSession = await mongoose.startSession()
  try {
    let session
    await mongooseSession.withTransaction(async () => {
      const vehicle = await Vehicle.findOneAndUpdate(
        { organizationId, vehicleNumber },
        { $setOnInsert: { organizationId, vehicleNumber, vehicleTypeId } },
        { upsert: true, new: true, session: mongooseSession },
      )

      let created
      try {
        created = (await ParkingSession.create([{
          organizationId, locationId, parkingAreaId: parkingAreaId || null, slotId: slotId || null,
          vehicleId: vehicle._id, vehicleTypeId, tokenId: token._id, pricingRuleVersionId: version._id,
          pricingMode: mode, status: 'CREATED', exitRequired,
          entryStaffId: staffUser._id, entryShiftInstanceId: shiftInstance._id, entryDeviceId: device._id,
          entryAt: entryDate, amountDueMinor, currency: location.currency, clientTransactionId,
        }], { session: mongooseSession }))[0]
      } catch (err) {
        if (err.code === 11000) {
          if (err.keyPattern?.vehicleId) throw createError(409, 'This vehicle already has an active session', null, 'VEHICLE_ALREADY_ACTIVE')
          if (err.keyPattern?.tokenId) throw createError(409, 'QR token is already in use', null, 'TOKEN_ALREADY_ACTIVE')
        }
        throw err
      }
      session = created

      await moveToken({
        mongooseSession, organizationId, tokenId: token._id, fromStatus: 'AVAILABLE', toStatus: 'ASSIGNED',
        sessionId: session._id, actorUserId: staffUser._id, deviceId: device._id, locationId, shiftInstanceId: shiftInstance._id,
      })
      await occupySlot({ mongooseSession, organizationId, slotId })

      if (isEntryPriced) {
        sessionStateMachine.assertTransition(mode, 'CREATED', 'PAYMENT_PENDING')
        session.status = 'PAYMENT_PENDING'
      } else {
        sessionStateMachine.assertTransition(mode, 'CREATED', 'ACTIVE')
        session.status = 'ACTIVE'
        await moveToken({
          mongooseSession, organizationId, tokenId: token._id, fromStatus: 'ASSIGNED', toStatus: 'ACTIVE',
          sessionId: session._id, actorUserId: staffUser._id, deviceId: device._id, locationId, shiftInstanceId: shiftInstance._id,
        })
      }
      await session.save({ session: mongooseSession })
    })

    await auditLog.recordSystem({
      organizationId, actorId: staffUser._id, actorRole: staffUser.role, actorName: staffUser.name,
      action: 'SESSION_ENTRY_CREATED', entityType: 'ParkingSession', entityId: session._id,
      newValue: { vehicleNumber, tokenCode, mode }, deviceId: device._id, locationId, shiftInstanceId: shiftInstance._id,
    })

    return { statusCode: 201, session }
  } finally {
    await mongooseSession.endSession()
  }
}

/**
 * requestExit — §12's flow up through the QR scan + amount calculation.
 * `session` here is the already-loaded-and-org-scoped ParkingSession doc
 * (loaded by the route's loadSession middleware before locationCheck runs
 * against its locationId).
 */
async function requestExit({ organizationId, staffUser, device, shiftInstance, session, body }) {
  const { tokenCode, exitAt } = body

  // A terminal (COMPLETED/CANCELLED) session's token has already cycled on
  // — possibly reassigned to a different session entirely — so this check
  // must run BEFORE the token-match check below, using the same
  // "no double exit" guarantee sessionStateMachine's TERMINAL_STATUSES
  // enforces (§1 item 14), not the idempotent-retry path further down.
  if (sessionStateMachine.TERMINAL_STATUSES.includes(session.status)) {
    throw createError(409, 'This transaction is already completed', null, 'SESSION_ALREADY_TERMINAL')
  }

  const token = await QrToken.findOne({ organizationId, _id: session.tokenId })
  if (!token || token.tokenCode !== tokenCode) {
    throw createError(404, 'QR token does not match this session', null, 'TOKEN_INVALID_STATUS')
  }
  if (String(token.currentSessionId) !== String(session._id)) {
    throw createError(409, 'QR token is not currently assigned to this session', null, 'TOKEN_INVALID_STATUS')
  }

  // Idempotent re-scan (§12 edge case found via on-device testing): staff
  // double-tapping "Find Vehicle", or a client retry after the response was
  // lost in flight, re-sends this exact request after exit was ALREADY
  // successfully requested. The token is still legitimately assigned to
  // this session at this point (RETURNED preserves currentSessionId), so
  // hand back the already-computed amount instead of erroring on the
  // PAYMENT_PENDING -> EXIT_REQUESTED transition sessionStateMachine
  // (correctly) no longer allows.
  if (session.status === 'PAYMENT_PENDING') {
    const durationMinutes = session.exitAt ? (session.exitAt.getTime() - session.entryAt.getTime()) / 60000 : undefined
    return { session, durationMinutes }
  }

  sessionStateMachine.assertTransition(session.pricingMode, session.status, 'EXIT_REQUESTED')

  const exitDate = exitAt ? new Date(exitAt) : new Date()
  if (exitDate <= session.entryAt) {
    throw createError(422, 'exitAt must be after entryAt', null, 'VALIDATION_ERROR')
  }

  const isEntryPriced = ENTRY_PRICED_MODES.includes(session.pricingMode)
  let calc = null
  if (!isEntryPriced) {
    const [location, version] = await Promise.all([
      Location.findOne({ _id: session.locationId, organizationId }),
      PricingRuleVersion.findOne({ _id: session.pricingRuleVersionId, organizationId }),
    ])
    calc = pricingEngine.calculateAmount({ config: version.config, entryAt: session.entryAt, exitAt: exitDate, timezone: location.timezone })
  }

  const mongooseSession = await mongoose.startSession()
  try {
    await mongooseSession.withTransaction(async () => {
      session.exitStaffId = staffUser._id
      session.exitShiftInstanceId = shiftInstance._id
      session.exitDeviceId = device._id
      session.exitAt = exitDate

      await moveToken({
        mongooseSession, organizationId, tokenId: token._id, fromStatus: 'ACTIVE', toStatus: 'RETURNED',
        sessionId: session._id, actorUserId: staffUser._id, deviceId: device._id, locationId: session.locationId, shiftInstanceId: shiftInstance._id,
      })

      if (isEntryPriced) {
        // Already paid in full at entry (that's the only way this session
        // ever reached ACTIVE) — exit completes the session directly.
        sessionStateMachine.assertTransition(session.pricingMode, 'EXIT_REQUESTED', 'COMPLETED')
        session.status = 'COMPLETED'
        await moveToken({
          mongooseSession, organizationId, tokenId: token._id, fromStatus: 'RETURNED', toStatus: 'AVAILABLE',
          sessionId: session._id, actorUserId: staffUser._id, deviceId: device._id, locationId: session.locationId, shiftInstanceId: shiftInstance._id,
        })
        await releaseSlot({ mongooseSession, organizationId, slotId: session.slotId })
      } else {
        sessionStateMachine.assertTransition(session.pricingMode, 'EXIT_REQUESTED', 'PAYMENT_PENDING')
        session.status = 'PAYMENT_PENDING'
        session.amountDueMinor = calc.amountMinor
      }

      await session.save({ session: mongooseSession })
    })

    await auditLog.recordSystem({
      organizationId, actorId: staffUser._id, actorRole: staffUser.role, actorName: staffUser.name,
      action: session.status === 'COMPLETED' ? 'SESSION_COMPLETED' : 'SESSION_EXIT_REQUESTED',
      entityType: 'ParkingSession', entityId: session._id,
      newValue: { status: session.status, amountDueMinor: session.amountDueMinor, durationMinutes: calc?.durationMinutes },
      deviceId: device._id, locationId: session.locationId, shiftInstanceId: shiftInstance._id,
    })

    return { session, durationMinutes: calc?.durationMinutes }
  } finally {
    await mongooseSession.endSession()
  }
}

/**
 * recordPayment — §11's flow. Chains PAYMENT_PENDING -> PAID -> (ACTIVE for
 * an entry-priced session settling at entry, or COMPLETED for an exit-priced
 * session settling at exit) in one request once the payment covers the full
 * amount due — PAID is not a resting state a caller has to separately
 * advance past.
 */
async function recordPayment({ organizationId, staffUser, device, shiftInstance, session, body }) {
  const { clientTransactionId, method, amountMinor, discountMinor = 0, discountReason } = body

  if (session.status !== 'PAYMENT_PENDING') {
    throw createError(409, 'This session is not awaiting payment', null, 'SESSION_INVALID_TRANSITION')
  }

  const existingPayment = await Payment.findOne({ organizationId, clientTransactionId })
  if (existingPayment) return { statusCode: 200, payment: existingPayment, session }

  if (discountMinor > 0) {
    const remainingDue = session.amountDueMinor - session.amountPaidMinor
    if (discountMinor > remainingDue) {
      throw createError(422, 'Discount cannot exceed the amount still due', null, 'VALIDATION_ERROR')
    }
    // Only queried on this path — the common no-discount payment doesn't pay
    // the cost of an extra read.
    const location = await Location.findOne({ _id: session.locationId, organizationId })
    if (!location?.features?.exitDiscount?.enabled) {
      throw createError(403, 'Discount is not enabled at this location', null, 'FEATURE_DISABLED')
    }
  }

  const isEntryPriced = ENTRY_PRICED_MODES.includes(session.pricingMode)
  const nextStatus = isEntryPriced ? 'ACTIVE' : 'COMPLETED'

  const mongooseSession = await mongoose.startSession()
  try {
    let payment
    await mongooseSession.withTransaction(async () => {
      payment = (await Payment.create([{
        organizationId, parkingSessionId: session._id, method, amountMinor, currency: session.currency,
        discountMinor, discountReason,
        status: 'PENDING', recordedBy: staffUser._id, shiftInstanceId: shiftInstance._id, deviceId: device._id, clientTransactionId,
      }], { session: mongooseSession }))[0]

      // A discount closes the gap between amountPaidMinor and amountDueMinor
      // the same way cash does, but only the actually-collected amountMinor
      // is added to session.amountPaidMinor — that field must keep meaning
      // "money actually collected" for shift-tally cash reconciliation.
      const totalPaid = session.amountPaidMinor + amountMinor
      const fullyPaid = (totalPaid + discountMinor) >= session.amountDueMinor
      payment.status = fullyPaid ? 'PAID' : 'PARTIALLY_PAID'
      await payment.save({ session: mongooseSession })

      session.amountPaidMinor = totalPaid

      if (fullyPaid) {
        sessionStateMachine.assertTransition(session.pricingMode, 'PAYMENT_PENDING', 'PAID')
        sessionStateMachine.assertTransition(session.pricingMode, 'PAID', nextStatus)
        session.status = nextStatus

        if (isEntryPriced) {
          await moveToken({
            mongooseSession, organizationId, tokenId: session.tokenId, fromStatus: 'ASSIGNED', toStatus: 'ACTIVE',
            sessionId: session._id, actorUserId: staffUser._id, deviceId: device._id, locationId: session.locationId, shiftInstanceId: shiftInstance._id,
          })
        } else {
          await moveToken({
            mongooseSession, organizationId, tokenId: session.tokenId, fromStatus: 'RETURNED', toStatus: 'AVAILABLE',
            sessionId: session._id, actorUserId: staffUser._id, deviceId: device._id, locationId: session.locationId, shiftInstanceId: shiftInstance._id,
          })
          await releaseSlot({ mongooseSession, organizationId, slotId: session.slotId })
        }
      }
      await session.save({ session: mongooseSession })
    })

    await auditLog.recordSystem({
      organizationId, actorId: staffUser._id, actorRole: staffUser.role, actorName: staffUser.name,
      action: session.status === 'COMPLETED' ? 'SESSION_COMPLETED' : 'SESSION_PAYMENT_RECORDED',
      entityType: 'ParkingSession', entityId: session._id,
      newValue: { method, amountMinor, sessionStatus: session.status, ...(discountMinor > 0 && { discountMinor, discountReason }) },
      deviceId: device._id, locationId: session.locationId, shiftInstanceId: shiftInstance._id,
    })

    return { statusCode: 201, payment, session }
  } finally {
    await mongooseSession.endSession()
  }
}

/**
 * cancelSession — §12/§F: Manager+ only, reason required, both enforced by
 * sessionStateMachine.assertTransition itself (not just the route guard).
 * Releases whatever the session was holding — token back to AVAILABLE (via
 * RETURNED first if it had reached ACTIVE, matching §G's real transition
 * table rather than inventing a shortcut path) and the slot, if any.
 */
async function cancelSession({ organizationId, staffUser, device, session, reason }) {
  sessionStateMachine.assertTransition(session.pricingMode, session.status, 'CANCELLED', { reason, actorRole: staffUser.role })

  const token = await QrToken.findOne({ organizationId, _id: session.tokenId })

  const mongooseSession = await mongoose.startSession()
  try {
    await mongooseSession.withTransaction(async () => {
      session.status = 'CANCELLED'
      session.cancelReason = reason
      await session.save({ session: mongooseSession })

      if (token.status === 'ACTIVE') {
        await moveToken({
          mongooseSession, organizationId, tokenId: token._id, fromStatus: 'ACTIVE', toStatus: 'RETURNED',
          sessionId: session._id, actorUserId: staffUser._id, deviceId: device._id, locationId: session.locationId,
          reason: 'session cancelled',
        })
        await moveToken({
          mongooseSession, organizationId, tokenId: token._id, fromStatus: 'RETURNED', toStatus: 'AVAILABLE',
          sessionId: session._id, actorUserId: staffUser._id, deviceId: device._id, locationId: session.locationId,
          reason: 'session cancelled',
        })
      } else if (token.status === 'ASSIGNED') {
        // ASSIGNED has no direct path to AVAILABLE in §G's table (only via
        // RETURNED, which presupposes the vehicle was ever actually parked) —
        // a cancelled-before-parking token didn't go anywhere, so it's
        // released with a direct status write here rather than forcing it
        // through a movement sequence that would misrepresent what happened.
        token.status = 'AVAILABLE'
        token.currentSessionId = null
        await token.save({ session: mongooseSession })
        await TokenMovement.create(
          [{ organizationId, tokenId: token._id, fromStatus: 'ASSIGNED', toStatus: 'AVAILABLE', sessionId: session._id, actorUserId: staffUser._id, deviceId: device._id, locationId: session.locationId, reason: 'session cancelled before parking' }],
          { session: mongooseSession },
        )
      }

      await releaseSlot({ mongooseSession, organizationId, slotId: session.slotId })
    })

    await auditLog.recordSystem({
      organizationId, actorId: staffUser._id, actorRole: staffUser.role, actorName: staffUser.name,
      action: 'SESSION_CANCELLED', entityType: 'ParkingSession', entityId: session._id,
      newValue: { reason }, deviceId: device._id, locationId: session.locationId,
    })

    return session
  } finally {
    await mongooseSession.endSession()
  }
}

module.exports = { enterVehicle, requestExit, recordPayment, cancelSession, ENTRY_PRICED_MODES }
