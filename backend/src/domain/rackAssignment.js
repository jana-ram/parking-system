/**
 * rackAssignment.js — picks the best available RackSlot for an item instead
 * of simply the first AVAILABLE one (§6: consider item type, size, weight,
 * security requirements, current occupancy). Pure function: takes plain
 * candidate slot objects (already scoped to the right org/location by the
 * caller) and a criteria object, returns the best match or null. No I/O.
 */
function fitsCapacity(slot, { weightKg, dimensions } = {}) {
  if (weightKg != null && slot.maxWeightKg != null && weightKg > slot.maxWeightKg) return false
  if (dimensions && slot.dimensions) {
    const { lengthCm, widthCm, heightCm } = slot.dimensions
    if (lengthCm != null && dimensions.lengthCm != null && dimensions.lengthCm > lengthCm) return false
    if (widthCm != null && dimensions.widthCm != null && dimensions.widthCm > widthCm) return false
    if (heightCm != null && dimensions.heightCm != null && dimensions.heightCm > heightCm) return false
  }
  return true
}

function volumeOf(slot) {
  const d = slot.dimensions
  if (!d || d.lengthCm == null || d.widthCm == null || d.heightCm == null) return Infinity
  return d.lengthCm * d.widthCm * d.heightCm
}

/**
 * suggestSlot(candidateSlots, { itemType, weightKg, dimensions, securityLevel })
 * Eligibility: AVAILABLE or RESERVED, allowed item type (empty allow-list =
 * no restriction), and fits weight/dimension constraints. Among eligible
 * slots, prefers an exact security-level match, then AVAILABLE over
 * RESERVED, then the smallest slot that still fits (don't waste a large or
 * high-security slot on a small item), then a deterministic slotCode
 * tie-break.
 */
function suggestSlot(candidateSlots, criteria = {}) {
  const { itemType, weightKg, dimensions, securityLevel } = criteria

  const eligible = candidateSlots.filter((slot) => {
    if (slot.status !== 'AVAILABLE' && slot.status !== 'RESERVED') return false
    if (itemType && Array.isArray(slot.allowedItemTypes) && slot.allowedItemTypes.length && !slot.allowedItemTypes.includes(itemType)) return false
    if (!fitsCapacity(slot, { weightKg, dimensions })) return false
    return true
  })
  if (!eligible.length) return null

  const scored = eligible.map((slot) => ({
    slot,
    securityMismatch: securityLevel && slot.securityLevel !== securityLevel ? 1 : 0,
    statusRank: slot.status === 'AVAILABLE' ? 0 : 1,
    volume: volumeOf(slot),
  }))

  scored.sort((a, b) =>
    a.securityMismatch - b.securityMismatch ||
    a.statusRank - b.statusRank ||
    a.volume - b.volume ||
    a.slot.slotCode.localeCompare(b.slot.slotCode)
  )

  return scored[0].slot
}

module.exports = { suggestSlot, fitsCapacity }
