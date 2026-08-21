const AuditLog = require('../models/AuditLog')

// GET /audit-logs?entityType=&entityId=&actorId=&action=&from=&to=
const listAuditLogs = async (req, res, next) => {
  try {
    const { entityType, entityId, actorId, action, from, to } = req.query
    const filter = { organizationId: req.staffUser.organizationId }
    if (entityType) filter.entityType = entityType
    if (entityId) filter.entityId = entityId
    if (actorId) filter.actorId = actorId
    if (action) filter.action = action
    if (from || to) {
      filter.createdAt = {}
      if (from) filter.createdAt.$gte = new Date(from)
      if (to) filter.createdAt.$lte = new Date(to)
    }

    const logs = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(200)
    res.json({ success: true, message: 'ok', data: { logs } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listAuditLogs }
