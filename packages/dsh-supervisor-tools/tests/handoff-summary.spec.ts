import { describe, expect, it } from 'vitest'
import { HANDOFF_SUMMARY_LIMIT, handoffSummaryError } from '../src/index.js'

describe('handoff summary limit', () => {
  it('accepts a summary at exactly the 2048-character boundary', () => {
    expect(handoffSummaryError('x'.repeat(HANDOFF_SUMMARY_LIMIT))).toBeUndefined()
    expect(handoffSummaryError('x'.repeat(HANDOFF_SUMMARY_LIMIT), 'task-123')).toBeUndefined()
  })

  it('rejects a summary one character over the boundary', () => {
    expect(handoffSummaryError('x'.repeat(HANDOFF_SUMMARY_LIMIT + 1))).toMatch(/exceeds 2048 characters/)
  })

  it('gives an actionable recovery instruction that names the concrete report directory', () => {
    const error = handoffSummaryError('x'.repeat(HANDOFF_SUMMARY_LIMIT + 1), 'task-123')
    expect(error).toContain('.dsh-handoff/task-123/')
    expect(error).toContain('session cwd')
    expect(error).toContain('artifacts')
    expect(error).toContain('concise summary')
  })

  it('falls back to a generic placeholder when no task id is available', () => {
    const error = handoffSummaryError('x'.repeat(HANDOFF_SUMMARY_LIMIT + 1))
    expect(error).toContain('.dsh-handoff/<taskId>/')
  })
})
