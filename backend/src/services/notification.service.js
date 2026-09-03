/**
 * notification.service.js — §20's "channels are extensible, don't hardcode
 * one provider into business logic" requirement. IN_APP is the only channel
 * actually wired (a Notification row, read via GET /notifications) since
 * no SMS/WhatsApp/email provider credentials exist in this environment —
 * the CHANNELS map is the extension point: add an adapter function here and
 * list it in a Notification's `channels` array, nothing else in the
 * codebase needs to change. Every call site (shift.service.js's mismatch
 * alert, anomaly flags, ...) goes through notify()/notifyRoles() rather
 * than writing to the Notification model directly, the same "one funnel"
 * discipline auditLog.service.js and correction.service.js already use.
 */
const Notification = require('../models/Notification')
const StaffUser = require('../models/StaffUser')

const CHANNELS = {
  // eslint-disable-next-line no-unused-vars
  IN_APP: async (notification) => {}, // the Notification row itself IS the in-app channel — nothing further to dispatch.
  // SMS: async (notification) => { /* plug a provider SDK call here */ },
  // WHATSAPP: async (notification) => { /* plug a provider SDK call here */ },
  // EMAIL: async (notification) => { /* plug a provider SDK call here */ },
}

async function notify({ organizationId, recipientUserId, type, severity, title, body, entityRef, channels = ['IN_APP'] }) {
  const notification = await Notification.create({ organizationId, recipientUserId, type, severity, title, body, entityRef })
  for (const channel of channels) {
    const adapter = CHANNELS[channel]
    if (adapter) await adapter(notification).catch(() => {}) // a channel failure never blocks the in-app record from existing
  }
  return notification
}

/**
 * notifyRoles — org-wide by role (e.g. every MANAGER/ORG_ADMIN), since
 * StaffUser accounts aren't pinned to one location (assignment is per-shift,
 * not per-account) — a real per-location manager roster isn't derivable
 * without that data model change, so this notifies everyone at the right
 * tier org-wide rather than silently under-notifying.
 */
async function notifyRoles({ organizationId, roles, type, severity, title, body, entityRef }) {
  const recipients = await StaffUser.find({ organizationId, role: { $in: roles }, status: 'ACTIVE' }).select('_id')
  return Promise.all(recipients.map((r) => notify({ organizationId, recipientUserId: r._id, type, severity, title, body, entityRef })))
}

module.exports = { notify, notifyRoles }
