/**
 * requireOrgScope — the belt-and-braces tenant-isolation guard described in
 * docs/ARCHITECTURE.md §E/§X. MongoDB has no Postgres-equivalent Row-Level
 * Security, so this plugin does that job by hand: it hooks every read/update/
 * delete query on a tenant-scoped model and throws instead of executing if the
 * query filter doesn't mention organizationId. A missing `.find({organizationId})`
 * clause becomes a hard 500 at query time instead of a silent cross-tenant leak.
 *
 * Usage:
 *   const requireOrgScope = require('../plugins/requireOrgScope')
 *   MySchema.plugin(requireOrgScope)
 *
 * Legitimate cross-org queries (platform-admin support tooling only — see the
 * /platform/* router in §B, which is the only code path that should ever need
 * this) must opt out explicitly and visibly:
 *   Model.find({...}).setOptions({ skipOrgScope: true })
 */
const QUERY_HOOKS = [
  'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndRemove',
  'countDocuments', 'updateMany', 'updateOne', 'deleteMany', 'deleteOne',
]

function requireOrgScope(schema, opts = {}) {
  const field = opts.field || 'organizationId'

  QUERY_HOOKS.forEach((hook) => {
    schema.pre(hook, function guardOrgScope(next) {
      if (this.getOptions().skipOrgScope === true) return next()

      const filter = this.getFilter()
      if (Object.prototype.hasOwnProperty.call(filter, field) && filter[field] != null) {
        return next()
      }

      const err = new Error(
        `Blocked ${hook}() on "${this.model.modelName}": query filter is missing "${field}". ` +
        `If this is a deliberate platform-level (cross-tenant) query, pass ` +
        `.setOptions({ skipOrgScope: true }) explicitly — never omit the filter by accident.`
      )
      err.statusCode = 500
      err.code = 'ORG_SCOPE_MISSING'
      next(err)
    })
  })

  // Aggregation pipelines bypass query middleware entirely, so they need a
  // separate, explicit entry point rather than a hook that can be silently
  // skipped. Prefer this over calling Model.aggregate() directly.
  schema.statics.aggregateScoped = function aggregateScoped(organizationId, pipeline = []) {
    if (!organizationId) {
      throw Object.assign(
        new Error(`aggregateScoped() called on "${this.modelName}" without an organizationId`),
        { statusCode: 500, code: 'ORG_SCOPE_MISSING' }
      )
    }
    return this.aggregate([{ $match: { [field]: organizationId } }, ...pipeline])
  }
}

module.exports = requireOrgScope
