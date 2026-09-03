const LuggageOrder = require('../models/LuggageOrder')
const LuggageItem = require('../models/LuggageItem')
const ParcelOrder = require('../models/ParcelOrder')
const ParcelItem = require('../models/ParcelItem')
const { createError } = require('../utils/helpers')

// A generic "not found" for every failure mode (wrong code, wrong phone,
// wrong org) — an unauthenticated caller who got the pairing wrong should
// not be able to distinguish "no such order" from "wrong phone number",
// which would otherwise make phone numbers guessable one order at a time.
const NOT_FOUND = () => createError(404, 'No matching order found', null, 'NOT_FOUND')

const getLuggageStatus = async (req, res, next) => {
  try {
    if (!req.publicOrg.modules?.LUGGAGE) return next(NOT_FOUND())
    const { phone } = req.query
    if (!phone) return next(createError(422, 'phone query param is required', null, 'VALIDATION_ERROR'))

    const order = await LuggageOrder.findOne({
      organizationId: req.publicOrg._id, orderCode: req.params.orderCode, customerPhone: phone.trim(),
    }).select('orderCode status checkInAt expectedPickupAt actualPickupAt amountDueMinor amountPaidMinor currency')
    if (!order) return next(NOT_FOUND())

    const items = await LuggageItem.find({ organizationId: req.publicOrg._id, orderId: order._id })
      .select('itemCode description quantity status')

    res.json({ success: true, message: 'ok', data: { order, items } })
  } catch (err) {
    next(err)
  }
}

const getParcelStatus = async (req, res, next) => {
  try {
    if (!req.publicOrg.modules?.PARCEL) return next(NOT_FOUND())
    const { phone } = req.query
    if (!phone) return next(createError(422, 'phone query param is required', null, 'VALIDATION_ERROR'))

    const order = await ParcelOrder.findOne({
      organizationId: req.publicOrg._id, orderCode: req.params.orderCode,
      $or: [{ receiverPhone: phone.trim() }, { senderPhone: phone.trim() }],
    }).select('orderCode status receivedAt expectedPickupAt actualPickupAt amountDueMinor amountPaidMinor currency')
    if (!order) return next(NOT_FOUND())

    const items = await ParcelItem.find({ organizationId: req.publicOrg._id, orderId: order._id })
      .select('itemCode parcelType description quantity status')

    res.json({ success: true, message: 'ok', data: { order, items } })
  } catch (err) {
    next(err)
  }
}

module.exports = { getLuggageStatus, getParcelStatus }
