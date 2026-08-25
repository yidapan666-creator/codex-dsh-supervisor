import { describe, expect, it } from 'vitest'
import {
  HANDOFF_SUMMARY_LIMIT, SUPERVISOR_PROGRESS_MIN_INTERVAL_MS,
  handoffIdentityError, handoffSummaryError, progressIdentityError, supervisorProgressDecision,
} from '../src/index.js'

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

describe('bounded supervisor progress', () => {
  const packet = (value: object): { type: string; time?: number; data: unknown } => ({
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
  const progress = {
    sessionId: v2.sessionId, runId: v2.runId,
    phase: 'implementing' as const,
    milestone: 'Identity fold is implemented.',
    nextAction: 'Run tests.',
    needsSupervisor: false,
  }
  const call = (args: object, time: number) => ({
    type: 'tool/call', time,
    data: { name: 'supervisor_progress', arguments: JSON.stringify(args) },
  })

  it('accepts progress for the current run and rejects stale run identity', () => {
    expect(progressIdentityError([packet(v2)], progress)).toBeUndefined()
    expect(progressIdentityError([packet(v2)], {
      ...progress, runId: '33333333-3333-4333-8333-333333333333',
    })).toMatch(/runId does not match/i)
  })

  it('deduplicates an identical prior progress record', () => {
    expect(supervisorProgressDecision([
      packet(v2), call(progress, 1_000), call(progress, 2_000),
    ], progress, 2_000)).toEqual({ accepted: false, reason: 'duplicate' })
  })

  it('rate-limits changed ordinary progress but lets a supervisor decision through', () => {
    const changed = { ...progress, milestone: 'Focused tests pass.' }
    expect(supervisorProgressDecision([
      packet(v2), call(progress, 1_000), call(changed, 2_000),
    ], changed, 1_000 + SUPERVISOR_PROGRESS_MIN_INTERVAL_MS - 1)).toEqual({
      accepted: false, reason: 'rate_limited',
    })
    const decision = { ...changed, needsSupervisor: true }
    expect(supervisorProgressDecision([
      packet(v2), call(progress, 1_000), call(decision, 2_000),
    ], decision, 2_000)).toEqual({ accepted: true })
  })
})
