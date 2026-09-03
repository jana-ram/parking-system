const Notification = require('../models/Notification')
const { createError } = require('../utils/helpers')

// GET /notifications?unreadOnly=true — a staff member's own notifications
// only (never another staff member's, even for ORG_ADMIN — this is an
// inbox, not an admin report; audit-style visibility belongs to /audit-logs).
const listMine = async (req, res, next) => {
  try {
    const filter = { organizationId: req.staffUser.organizationId, recipientUserId: req.staffUser._id }
    if (req.query.unreadOnly === 'true') filter.readAt = null
    const notifications = await Notification.find(filter).sort({ createdAt: -1 }).limit(200)
    const unreadCount = await Notification.countDocuments({ organizationId: req.staffUser.organizationId, recipientUserId: req.staffUser._id, readAt: null })
    res.json({ success: true, message: 'ok', data: { notifications, unreadCount } })
  } catch (err) {
    next(err)
  }
}

const markRead = async (req, res, next) => {
  try {
    const notification = await Notification.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId, recipientUserId: req.staffUser._id })
    if (!notification) return next(createError(404, 'Notification not found', null, 'NOT_FOUND'))
    if (!notification.readAt) {
      notification.readAt = new Date()
      await notification.save()
    }
    res.json({ success: true, message: 'ok', data: { notification } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listMine, markRead }
