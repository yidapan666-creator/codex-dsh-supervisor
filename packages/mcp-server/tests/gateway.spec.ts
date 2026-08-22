import type { SessionSummary } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it } from 'vitest'
import { attachChildObservations } from '../src/gateway.js'

describe('child observability', () => {
  it('attaches existing session projections without changing child ownership fields', () => {
    const entries = [{ kind: 'child', id: 'child-1', mode: 'continuable', activity: 'inactive' }]
    const sessions = [{
      sessionId: 'child-1', updatedAt: 1, running: false, blank: false,
      projections: {
        asOfSeq: 42,
        values: {
          sessionStats: { turns: 2, steps: 7 },
          tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
        },
      },
    }] as unknown as SessionSummary[]

    expect(attachChildObservations(entries, sessions)).toEqual([{
      kind: 'child', id: 'child-1', mode: 'continuable', activity: 'inactive',
      observation: {
        workerState: 'IDLE',
        telemetry: {
          asOfSeq: 42,
          sessionStats: { turns: 2, steps: 7 },
          tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
        },
      },
    }])
  })

  it('leaves a catalog entry observable even when its session row is unavailable', () => {
    expect(attachChildObservations([{ id: 'cold-child', activity: 'inactive' }], []))
      .toEqual([{ id: 'cold-child', activity: 'inactive' }])
  })
})
