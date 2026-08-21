/**
 * SyncEvent — server-side record of each offline-originated push (§23-§25).
 * retryCount/nextAttemptAt back the bounded-backoff / retry-storm detection
 * described in §25 and the anomaly rule in §R.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const SYNC_STATUSES = ['PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'BLOCKED', 'CONFLICT']

const SyncEventSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  entityType: { type: String, required: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
  clientTransactionId: { type: String, required: true },
  operation: { type: String, enum: ['CREATE', 'UPDATE'], required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  status: { type: String, enum: SYNC_STATUSES, default: 'PENDING' },
  retryCount: { type: Number, default: 0 },
  lastAttemptAt: Date,
  nextAttemptAt: Date,
  error: mongoose.Schema.Types.Mixed,
  serverVersion: Number,
}, { timestamps: true })

SyncEventSchema.index({ organizationId: 1, clientTransactionId: 1 }, { unique: true })
SyncEventSchema.index({ deviceId: 1, status: 1 })
SyncEventSchema.statics.STATUSES = SYNC_STATUSES
SyncEventSchema.plugin(requireOrgScope)

module.exports = mongoose.model('SyncEvent', SyncEventSchema)
