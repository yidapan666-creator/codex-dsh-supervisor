import { describe, expect, it } from 'vitest'
import { needsOlderHistoryPage } from '../src/host.js'

describe('durable history overlap pagination', () => {
  it('hydrates all older pages when no contiguous baseline exists', () => {
    expect(needsOlderHistoryPage('s1', true, 500, undefined)).toBe(true)
  })

  it('stops once the tail window touches the known contiguous prefix', () => {
    expect(needsOlderHistoryPage('s1', true, 101, 100)).toBe(false)
    expect(needsOlderHistoryPage('s1', true, 80, 100)).toBe(false)
  })

  it('continues backward across a gap and validates malformed pages', () => {
    expect(needsOlderHistoryPage('s1', true, 102, 100)).toBe(true)
    expect(needsOlderHistoryPage('s1', false, undefined, 100)).toBe(false)
    expect(() => needsOlderHistoryPage('s1', true, undefined, 100)).toThrow(/invalid history pagination/)
  })
})
