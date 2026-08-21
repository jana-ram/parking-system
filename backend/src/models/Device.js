/**
 * Device — a registered staff/admin mobile handset (§28, §N). deviceSecretEnc
 * stores the per-device HMAC secret encrypted-at-rest (AES-256-GCM using
 * DEVICE_SECRET_ENC_KEY), NOT bcrypt-hashed — HMAC verification needs the
 * plaintext secret back, which a one-way hash can't give us. See §N for why
 * this is a deliberate simplification from an asymmetric-keypair scheme.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const DEVICE_STATUSES = ['ACTIVE', 'DEACTIVATED', 'SUSPICIOUS']

const DeviceSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
  deviceUuid: { type: String, required: true, unique: true },
  deviceSecretEnc: { type: String, required: true, select: false }, // AES-GCM ciphertext, base64
  registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
  platform: { type: String, default: 'ANDROID' },
  appVersion: String,
  osVersion: String,
  status: { type: String, enum: DEVICE_STATUSES, default: 'ACTIVE' },
  lastActiveAt: Date,
  lastSyncAt: Date,
  deactivatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' },
  deactivatedReason: String,
}, { timestamps: true })

DeviceSchema.statics.STATUSES = DEVICE_STATUSES
DeviceSchema.plugin(requireOrgScope)

module.exports = mongoose.model('Device', DeviceSchema)
