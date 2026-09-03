const { suggestSlot, fitsCapacity } = require('../rackAssignment')

function slot(overrides = {}) {
  return {
    slotCode: 'A01',
    status: 'AVAILABLE',
    allowedItemTypes: [],
    securityLevel: 'STANDARD',
    maxWeightKg: null,
    dimensions: null,
    ...overrides,
  }
}

describe('rackAssignment.suggestSlot', () => {
  test('returns null when no slot is eligible', () => {
    expect(suggestSlot([], { itemType: 'LUGGAGE' })).toBeNull()
    expect(suggestSlot([slot({ status: 'OCCUPIED' })], { itemType: 'LUGGAGE' })).toBeNull()
  })

  test('filters out slots that do not allow the requested item type', () => {
    const s = [slot({ slotCode: 'A01', allowedItemTypes: ['PARCEL'] })]
    expect(suggestSlot(s, { itemType: 'LUGGAGE' })).toBeNull()
  })

  test('a slot with an empty allow-list accepts any item type', () => {
    const s = [slot({ slotCode: 'A01', allowedItemTypes: [] })]
    expect(suggestSlot(s, { itemType: 'LUGGAGE' })?.slotCode).toBe('A01')
  })

  test('does not pick a slot too small or too weak for the item', () => {
    const s = [slot({ slotCode: 'A01', maxWeightKg: 5 })]
    expect(suggestSlot(s, { itemType: 'LUGGAGE', weightKg: 10 })).toBeNull()
    expect(suggestSlot(s, { itemType: 'LUGGAGE', weightKg: 3 })?.slotCode).toBe('A01')
  })

  test('prefers the smallest slot that still fits over a larger one', () => {
    const small = slot({ slotCode: 'A01', dimensions: { lengthCm: 30, widthCm: 30, heightCm: 30 } })
    const large = slot({ slotCode: 'A02', dimensions: { lengthCm: 100, widthCm: 100, heightCm: 100 } })
    const best = suggestSlot([large, small], {
      itemType: 'LUGGAGE',
      dimensions: { lengthCm: 20, widthCm: 20, heightCm: 20 },
    })
    expect(best.slotCode).toBe('A01')
  })

  test('prefers an exact security-level match over a mismatched one, even if the mismatch is smaller', () => {
    const mismatched = slot({ slotCode: 'A01', securityLevel: 'STANDARD', dimensions: { lengthCm: 10, widthCm: 10, heightCm: 10 } })
    const matched = slot({ slotCode: 'A02', securityLevel: 'HIGH', dimensions: { lengthCm: 50, widthCm: 50, heightCm: 50 } })
    const best = suggestSlot([mismatched, matched], { itemType: 'PARCEL', securityLevel: 'HIGH' })
    expect(best.slotCode).toBe('A02')
  })

  test('prefers AVAILABLE over RESERVED when otherwise equal', () => {
    const reserved = slot({ slotCode: 'A01', status: 'RESERVED' })
    const available = slot({ slotCode: 'A02', status: 'AVAILABLE' })
    expect(suggestSlot([reserved, available], { itemType: 'LUGGAGE' }).slotCode).toBe('A02')
  })

  test('ties break deterministically by slotCode', () => {
    const a = slot({ slotCode: 'B01' })
    const b = slot({ slotCode: 'A01' })
    expect(suggestSlot([a, b], { itemType: 'LUGGAGE' }).slotCode).toBe('A01')
  })
})

describe('rackAssignment.fitsCapacity', () => {
  test('a slot with no dimensions/weight limit fits anything', () => {
    expect(fitsCapacity(slot(), { weightKg: 1000, dimensions: { lengthCm: 1000, widthCm: 1000, heightCm: 1000 } })).toBe(true)
  })
})
