const AuditLog = require('../../models/AuditLog')

/**
 * GET /platform/audit — cross-org audit drill-in for support cases (§T, §21).
 *
 * [Phase 8 scope note] The architecture doc's §T calls for this platform
 * read to itself be audit-logged ("who looked at whose data"). It isn't yet:
 * AuditLog.organizationId is a REQUIRED field (§E), so a platform-level "read
 * event" has nowhere to attach without either (a) making organizationId
 * nullable there too (weakening a real invariant for every tenant row, for
 * one platform-only use case) or (b) a separate PlatformAuditLog collection.
 * Neither is done here — flagged plainly rather than bolted on with the
 * wrong shape.
 */
const listAuditLogs = async (req, res, next) => {
  try {
    const { organizationId, entityType, action } = req.query
    const filter = {}
    if (organizationId) filter.organizationId = organizationId
    if (entityType) filter.entityType = entityType
    if (action) filter.action = action

    const logs = await AuditLog.find(filter)
      .setOptions({ skipOrgScope: true })
      .populate('organizationId', 'name code')
      .sort({ createdAt: -1 })
      .limit(300)
    res.json({ success: true, message: 'ok', data: { logs } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listAuditLogs }
