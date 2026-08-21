const Organization = require('../models/Organization')
const auditLog = require('../services/auditLog.service')

const getMe = async (req, res, next) => {
  try {
    const org = await Organization.findById(req.staffUser.organizationId)
    res.json({ success: true, message: 'ok', data: { organization: org } })
  } catch (err) {
    next(err)
  }
}

const updateMe = async (req, res, next) => {
  try {
    const org = await Organization.findById(req.staffUser.organizationId)
    const oldValue = { name: org.name, defaultCurrency: org.defaultCurrency, defaultTimezone: org.defaultTimezone }
    Object.assign(org, req.body)
    await org.save()

    await auditLog.record(req, {
      action: 'ORGANIZATION_UPDATED',
      entityType: 'Organization',
      entityId: org._id,
      oldValue,
      newValue: req.body,
    })

    res.json({ success: true, message: 'Organization updated', data: { organization: org } })
  } catch (err) {
    next(err)
  }
}

module.exports = { getMe, updateMe }
