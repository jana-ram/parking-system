/**
 * Coarse item-type categories a RackSlot can be configured to accept (§4/§6
 * of the platform brief's Universal Item/Asset Engine). Deliberately a flat
 * enum here rather than a full generic Asset/Item model: VehicleType already
 * carries finer-grained vehicle subtypes, and Luggage/Parcel don't have
 * their own collections yet, so this is the smallest addition that lets a
 * rack be configured today and extended later (e.g. a new 'GOODS' variant)
 * with a one-line change here, no migration.
 */
const RACK_ITEM_TYPES = ['VEHICLE', 'LUGGAGE', 'PARCEL', 'GOODS']

module.exports = { RACK_ITEM_TYPES }
