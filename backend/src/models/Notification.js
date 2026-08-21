const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const NotificationSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' },
  type: { type: String, required: true },
  severity: { type: String, enum: ['INFO', 'WARNING', 'CRITICAL'], required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  entityRef: mongoose.Schema.Types.Mixed,
  readAt: Date,
}, { timestamps: true })

NotificationSchema.index({ organizationId: 1, recipientUserId: 1, readAt: 1 })
NotificationSchema.plugin(requireOrgScope)

module.exports = mongoose.model('Notification', NotificationSchema)
