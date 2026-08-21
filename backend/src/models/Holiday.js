const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const HolidaySchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' }, // null = applies org-wide
  date: { type: Date, required: true },
  name: { type: String, required: true, trim: true },
}, { timestamps: true })

HolidaySchema.plugin(requireOrgScope)

module.exports = mongoose.model('Holiday', HolidaySchema)
