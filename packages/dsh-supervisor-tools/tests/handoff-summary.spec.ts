import { describe, expect, it } from 'vitest'
import { HANDOFF_SUMMARY_LIMIT, handoffIdentityError, handoffSummaryError } from '../src/index.js'

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

describe('handoff run identity', () => {
  const packet = (value: object): { type: string; data: unknown } => ({
    type: 'user/message',
    data: { content: [{ type: 'text', text: `<dsh-supervised-task>\n${JSON.stringify(value)}\n</dsh-supervised-task>` }] },
  })
  const v2 = {
    schemaVersion: 2,
    sessionId: 'session-1',
    runId: '11111111-1111-4111-8111-111111111111',
    completionToken: '22222222-2222-4222-8222-222222222222',
    objective: 'ship it',
    writerMode: 'writer',
  }

  it('accepts the exact latest session, run, and completion token', () => {
    expect(handoffIdentityError([packet(v2)], {
      sessionId: v2.sessionId, runId: v2.runId, completionToken: v2.completionToken,
    })).toBeUndefined()
  })

  it('rejects a stale run before the worker concludes its turn', () => {
    expect(handoffIdentityError([packet(v2)], {
      sessionId: v2.sessionId,
      runId: '33333333-3333-4333-8333-333333333333',
      completionToken: v2.completionToken,
    })).toMatch(/runId does not match/i)
  })

  it('rejects a wrong completion token before the worker concludes its turn', () => {
    expect(handoffIdentityError([packet(v2)], {
      sessionId: v2.sessionId,
      runId: v2.runId,
      completionToken: '33333333-3333-4333-8333-333333333333',
    })).toMatch(/completionToken does not match/i)
  })
})
