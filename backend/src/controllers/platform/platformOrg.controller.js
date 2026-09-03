const mongoose = require('mongoose')
const Organization = require('../../models/Organization')
const Country = require('../../models/Country')
const StaffUser = require('../../models/StaffUser')
const AuditLog = require('../../models/AuditLog')
const { createError } = require('../../utils/helpers')

// Organization itself carries no organizationId field (it IS the tenant root,
// §E) so requireOrgScope was never applied to this model — there's nothing to
// scope by. These are the platform's own cross-tenant queries by construction,
// not queries that need to opt out of a guard.

/**
 * POST /platform/organizations — onboards a new tenant. Creates the
 * Organization AND its first StaffUser(ORG_ADMIN) together, atomically: there
 * is deliberately no self-serve staff signup route (§O — only an existing
 * ORG_ADMIN can create a StaffUser), so without this, a freshly created
 * organization would have no way to ever get its first account. Wrapped in a
 * transaction (§1.1) so a failure creating the admin account (e.g. duplicate
 * phone — vanishingly unlikely on a brand-new org, but possible) never leaves
 * an orphaned, admin-less organization behind.
 */
const createOrganization = async (req, res, next) => {
  const { name, code, countryId, defaultCurrency, defaultTimezone, orgAdmin } = req.body

  const country = await Country.findById(countryId)
  if (!country) return next(createError(422, 'Unknown countryId', null, 'VALIDATION_ERROR'))

  const session = await mongoose.startSession()
  try {
    let org, admin
    await session.withTransaction(async () => {
      org = (await Organization.create([{ name, code, countryId, defaultCurrency, defaultTimezone }], { session }))[0]
      admin = (await StaffUser.create(
        [{
          organizationId: org._id,
          name: orgAdmin.name,
          phone: orgAdmin.phone,
          password: orgAdmin.password,
          role: 'ORG_ADMIN',
        }],
        { session },
      ))[0]
      await AuditLog.create([{
        organizationId: org._id,
        actorId: req.platformAdmin._id,
        actorRole: 'PLATFORM_ADMIN',
        actorName: req.platformAdmin.name,
        action: 'ORGANIZATION_CREATED',
        entityType: 'Organization',
        entityId: org._id,
        newValue: { name, code, firstAdminPhone: orgAdmin.phone },
      }], { session })
    })

    res.status(201).json({
      success: true,
      message: 'Organization created',
      data: { organization: org, orgAdmin: { id: admin._id, name: admin.name, phone: admin.phone } },
    })
  } catch (err) {
    if (err.code === 11000) return next(createError(409, 'An organization with this code, or a staff account with this phone, already exists', null, 'VALIDATION_ERROR'))
    next(err)
  } finally {
    await session.endSession()
  }
}

const listOrganizations = async (req, res, next) => {
  try {
    const orgs = await Organization.find({}).sort({ createdAt: -1 })
    res.json({ success: true, message: 'ok', data: { organizations: orgs } })
  } catch (err) {
    next(err)
  }
}

const getOrganization = async (req, res, next) => {
  try {
    const org = await Organization.findById(req.params.id)
    if (!org) return next(createError(404, 'Organization not found', null, 'NOT_FOUND'))
    res.json({ success: true, message: 'ok', data: { organization: org } })
  } catch (err) {
    next(err)
  }
}

const updateOrganizationStatus = async (req, res, next) => {
  try {
    const { status } = req.body
    const org = await Organization.findById(req.params.id)
    if (!org) return next(createError(404, 'Organization not found', null, 'NOT_FOUND'))

    const oldStatus = org.status
    org.status = status
    await org.save()

    await AuditLog.create({
      organizationId: org._id,
      actorId: req.platformAdmin._id,
      actorRole: 'PLATFORM_ADMIN',
      actorName: req.platformAdmin.name,
      action: 'PLATFORM_ORG_STATUS_CHANGED',
      entityType: 'Organization',
      entityId: org._id,
      oldValue: { status: oldStatus },
      newValue: { status },
    })

    res.json({ success: true, message: 'Organization status updated', data: { organization: org } })
  } catch (err) {
    next(err)
  }
}

/**
 * PATCH /platform/organizations/:id/modules — Super Admin feature-module
 * toggle (§2). Deliberately merges only the keys present in req.body onto
 * the existing modules object, one path at a time, rather than replacing the
 * whole sub-document (contrast location.controller.js's updateLocation,
 * which does `Object.assign(location, req.body)` and would silently reset
 * every unmentioned key back to its schema default) — flipping RACK on must
 * never risk turning PARKING off as a side effect.
 */
const updateOrganizationModules = async (req, res, next) => {
  try {
    const org = await Organization.findById(req.params.id)
    if (!org) return next(createError(404, 'Organization not found', null, 'NOT_FOUND'))

    const oldValue = org.modules.toObject()
    for (const [key, value] of Object.entries(req.body)) {
      org.modules[key] = value
    }
    await org.save()

    await AuditLog.create({
      organizationId: org._id,
      actorId: req.platformAdmin._id,
      actorRole: 'PLATFORM_ADMIN',
      actorName: req.platformAdmin.name,
      action: 'PLATFORM_ORG_MODULES_CHANGED',
      entityType: 'Organization',
      entityId: org._id,
      oldValue,
      newValue: org.modules.toObject(),
    })

    res.json({ success: true, message: 'Organization modules updated', data: { organization: org } })
  } catch (err) {
    next(err)
  }
}

module.exports = { createOrganization, listOrganizations, getOrganization, updateOrganizationStatus, updateOrganizationModules }
