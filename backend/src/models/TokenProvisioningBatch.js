/**
 * TokenProvisioningBatch — records a bulk import of physical QR tokens (§1
 * item 1: tokens are manufactured/printed in bulk, offline of any transaction,
 * then provisioned into the system via this batch record).
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const TokenProvisioningBatchSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  batchSize: { type: Number, required: true },
  importedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser', required: true },
  notes: String,
}, { timestamps: true })

TokenProvisioningBatchSchema.plugin(requireOrgScope)

module.exports = mongoose.model('TokenProvisioningBatch', TokenProvisioningBatchSchema)
