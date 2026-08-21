const Anomaly = require('../models/Anomaly')
const auditLog = require('../services/auditLog.service')
const { createError } = require('../utils/helpers')

const listAnomalies = async (req, res, next) => {
  try {
    const filter = { organizationId: req.staffUser.organizationId }
    if (req.query.status) filter.status = req.query.status
    if (req.query.riskLevel) filter.riskLevel = req.query.riskLevel
    const anomalies = await Anomaly.find(filter).sort({ createdAt: -1 }).limit(200)
    res.json({ success: true, message: 'ok', data: { anomalies } })
  } catch (err) {
    next(err)
  }
}

// §20: "Do NOT automatically accuse staff of theft" — review sets a
// deliberately neutral outcome (REVIEWED or DISMISSED), never anything
// that reads as a verdict.
const reviewAnomaly = async (req, res, next) => {
  try {
    const { status } = req.body // 'REVIEWED' | 'DISMISSED'
    const anomaly = await Anomaly.findOne({ _id: req.params.id, organizationId: req.staffUser.organizationId })
    if (!anomaly) return next(createError(404, 'Anomaly not found', null, 'NOT_FOUND'))

    anomaly.status = status
    anomaly.reviewedBy = req.staffUser._id
    await anomaly.save()

    await auditLog.record(req, {
      action: 'ANOMALY_REVIEWED', entityType: 'Anomaly', entityId: anomaly._id, newValue: { status },
    })

    res.json({ success: true, message: 'Anomaly updated', data: { anomaly } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listAnomalies, reviewAnomaly }
