/**
 * ShiftTemplate — the SCHEDULE for a location (e.g. Morning 06:00-14:00). The
 * accountable unit is ShiftInstance, one per (location, staff, device)
 * activation — see §1 item 6 for why a single shift-per-location model
 * doesn't work once multiple staff work the same window concurrently.
 */
const mongoose = require('mongoose')
const requireOrgScope = require('../plugins/requireOrgScope')

const ShiftTemplateSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true, index: true },
  name: { type: String, required: true, trim: true }, // 'Morning','Evening','Night'
  startTime: { type: String, required: true }, // "HH:mm", 24h, in Location.timezone
  endTime: { type: String, required: true },
  daysOfWeek: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] }, // 0=Sunday
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

ShiftTemplateSchema.plugin(requireOrgScope)

module.exports = mongoose.model('ShiftTemplate', ShiftTemplateSchema)
