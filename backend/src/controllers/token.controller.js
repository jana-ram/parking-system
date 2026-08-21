const crypto = require('crypto')
const mongoose = require('mongoose')
const QrToken = require('../models/QrToken')
const TokenProvisioningBatch = require('../models/TokenProvisioningBatch')
const TokenMovement = require('../models/TokenMovement')
const tokenStateMachine = require('../domain/tokenStateMachine')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

/**
 * signPayload — the "qrPayloadHash" stored on each token (§7). The physical
 * card's printed QR encodes {tokenCode, sig}; sig = HMAC(tokenCode, org
 * secret) so a photographed/cloned QR still only ever resolves to the SAME
 * token_id server-side — cloning doesn't forge a NEW valid token, it just
 * inherits whatever state the real one is already in (documented limitation,
 * §7/§X, NFC is the real fix for high-security tiers).
 */
function signTokenCode(organizationId, tokenCode) {
  const key = process.env.JWT_SECRET // reusing the org-independent server secret is sufficient here — this is an integrity check, not a confidentiality one
  return crypto.createHmac('sha256', key).update(`${organizationId}:${tokenCode}`).digest('hex')
}

/**
 * POST /token-batches — bulk-provisions N physical tokens for a location
 * (§1 item 1: tokens are manufactured/printed in bulk, offline of any
 * transaction, then imported here). Generates sequential human-readable
 * codes; a real deploy might instead import a vendor-supplied CSV of
 * pre-printed codes — same shape, different source of tokenCode values.
 */
const provisionBatch = async (req, res, next) => {
  const { locationId, batchSize, notes } = req.body
  if (!batchSize || batchSize < 1 || batchSize > 5000) {
    return next(createError(422, 'batchSize must be between 1 and 5000', null, 'VALIDATION_ERROR'))
  }

  const session = await mongoose.startSession()
  try {
    let batch, tokens
    await session.withTransaction(async () => {
      batch = (await TokenProvisioningBatch.create(
        [{ organizationId: req.staffUser.organizationId, locationId, batchSize, importedBy: req.staffUser._id, notes }],
        { session },
      ))[0]

      const prefix = `PKG-${Date.now().toString().slice(-6)}`
      const docs = Array.from({ length: batchSize }, (_, i) => {
        const tokenCode = `${prefix}-${String(i + 1).padStart(4, '0')}`
        return {
          organizationId: req.staffUser.organizationId,
          locationId,
          batchId: batch._id,
          tokenCode,
          qrPayloadHash: signTokenCode(req.staffUser.organizationId, tokenCode),
        }
      })
      tokens = await QrToken.insertMany(docs, { session })
    })

    await auditLog.record(req, {
      action: 'TOKEN_PROVISIONED',
      entityType: 'TokenProvisioningBatch',
      entityId: batch._id,
      newValue: { batchSize, locationId },
      locationId,
    })

    res.status(201).json({
      success: true,
      message: `${tokens.length} tokens provisioned`,
      data: { batch, tokens: tokens.map(t => ({ id: t._id, tokenCode: t.tokenCode })) },
    })
  } catch (err) {
    next(err)
  } finally {
    await session.endSession()
  }
}

const listTokens = async (req, res, next) => {
  try {
    const filter = { organizationId: req.staffUser.organizationId }
    if (req.query.status) filter.status = req.query.status
    if (req.query.locationId) filter.locationId = req.query.locationId
    const tokens = await QrToken.find(filter).sort({ tokenCode: 1 }).limit(500)
    res.json({ success: true, message: 'ok', data: { tokens } })
  } catch (err) {
    next(err)
  }
}

// GET /tokens/summary — the inventory counts §6 asks the Admin dashboard to show.
const tokenSummary = async (req, res, next) => {
  try {
    const rows = await QrToken.aggregateScoped(req.staffUser.organizationId, [
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])
    const summary = Object.fromEntries(tokenStateMachine.STATUSES.map(s => [s, 0]))
    for (const row of rows) summary[row._id] = row.count
    summary.total = Object.values(summary).reduce((a, b) => a + b, 0)
    res.json({ success: true, message: 'ok', data: { summary } })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /tokens/:id/reinstate — the ONLY way LOST/DAMAGED/BLOCKED -> AVAILABLE
 * happens (§6). Manager+ only, reason required — both enforced by
 * tokenStateMachine.assertTransition itself, not just by the route guard.
 */
const reinstateToken = async (req, res, next) => {
  try {
    const { reason } = req.body
    const token = await QrToken.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!token) return next(createError(404, 'Token not found', null, 'NOT_FOUND'))

    tokenStateMachine.assertTransition(token.status, 'AVAILABLE', { authorizedReinstate: true, reason })

    const fromStatus = token.status
    token.status = 'AVAILABLE'
    await token.save()

    await TokenMovement.create({
      organizationId: req.staffUser.organizationId,
      tokenId: token._id,
      fromStatus,
      toStatus: 'AVAILABLE',
      actorUserId: req.staffUser._id,
      deviceId: req.device._id,
      locationId: token.locationId,
      reason,
    })

    await auditLog.record(req, {
      action: 'TOKEN_REINSTATED',
      entityType: 'QrToken',
      entityId: token._id,
      oldValue: { status: fromStatus },
      newValue: { status: 'AVAILABLE', reason },
      locationId: token.locationId,
    })

    res.json({ success: true, message: 'Token reinstated', data: { token } })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /tokens/:id/status — §16/§34's "Block tag / Mark lost / Mark
 * damaged": the forward transition reinstateToken's sibling doesn't cover.
 * Manager+ only, reason required, same as reinstate — this is a manual
 * override of the normal entry/exit-driven lifecycle, not a casual flip.
 * A token that's currently ASSIGNED/ACTIVE (mid-session) can only go to
 * LOST here (tokenStateMachine's own transition table), never
 * DAMAGED/BLOCKED — reporting a token missing mid-use is real; reporting it
 * "damaged" while a customer is still using it to park doesn't make sense
 * and the state machine already refuses it, not just this route.
 */
const markTokenStatus = async (req, res, next) => {
  try {
    const { status, reason } = req.body
    const token = await QrToken.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!token) return next(createError(404, 'Token not found', null, 'NOT_FOUND'))

    tokenStateMachine.assertTransition(token.status, status)

    const fromStatus = token.status
    token.status = status
    // currentSessionId is deliberately left as-is (not cleared) — if this
    // token was ASSIGNED/ACTIVE, that session reference is legitimate
    // history ("which session was open when this token went missing"), the
    // same convention moveToken() already uses for every non-AVAILABLE
    // target (session.service.js). The underlying ParkingSession itself is
    // untouched here — resolving an orphaned session from a lost/damaged
    // token is a separate, manual staff action (Search Vehicle), not
    // something this status change does implicitly.
    await token.save()

    await TokenMovement.create({
      organizationId: req.staffUser.organizationId,
      tokenId: token._id,
      fromStatus,
      toStatus: status,
      actorUserId: req.staffUser._id,
      deviceId: req.device._id,
      locationId: token.locationId,
      reason,
    })

    await auditLog.record(req, {
      action: 'TOKEN_STATUS_CHANGED',
      entityType: 'QrToken',
      entityId: token._id,
      oldValue: { status: fromStatus },
      newValue: { status, reason },
      locationId: token.locationId,
    })

    res.json({ success: true, message: 'Token status updated', data: { token } })
  } catch (err) {
    next(err)
  }
}

module.exports = { provisionBatch, listTokens, tokenSummary, reinstateToken, markTokenStatus, signTokenCode }
