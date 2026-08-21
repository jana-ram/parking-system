/**
 * QrToken — a reusable physical QR token/card (§6). Lifecycle is enforced by
 * src/domain/tokenStateMachine.js, never by a bare .save() from a controller —
 * see docs/ARCHITECTURE.md §G for the full transition table.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const TOKEN_STATUSES = ['AVAILABLE', 'ASSIGNED', 'ACTIVE', 'RETURNED', 'LOST', 'DAMAGED', 'BLOCKED']

const QrTokenSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true, index: true },
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'TokenProvisioningBatch' },
  tokenCode: { type: String, required: true, trim: true }, // human readable, e.g. PKG-004821
  qrPayloadHash: { type: String, required: true }, // server-verifiable signed payload hash, §7
  status: { type: String, enum: TOKEN_STATUSES, default: 'AVAILABLE' },
  currentSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParkingSession', default: null },
}, { timestamps: true })

QrTokenSchema.index({ organizationId: 1, tokenCode: 1 }, { unique: true })
QrTokenSchema.index({ organizationId: 1, status: 1 })
QrTokenSchema.statics.STATUSES = TOKEN_STATUSES
QrTokenSchema.plugin(requireOrgScope)

module.exports = mongoose.model('QrToken', QrTokenSchema)
