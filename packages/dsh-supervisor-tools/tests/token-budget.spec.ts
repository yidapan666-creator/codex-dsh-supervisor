import { describe, expect, it } from 'vitest'
import { liveTokenBudgetState } from '../src/index.js'

const runId = '11111111-1111-4111-8111-111111111111'
const packet = {
  schemaVersion: 2,
  sessionId: 'root',
  runId,
  completionToken: '22222222-2222-4222-8222-222222222222',
  objective: 'bounded work',
  writerMode: 'writer',
  budget: { maxTokens: 150 },
}

const packetEvent = {
  type: 'user/message', seq: 0, data: {
    content: [{ type: 'text', text: `<dsh-supervised-task>\n${JSON.stringify(packet)}\n</dsh-supervised-task>` }],
  },
}

const usage = (seq: number, turn: number, step: number, inputTokens: number, outputTokens: number) => ({
  type: 'assistant/message', seq, data: { turn, step, usage: { inputTokens, outputTokens } },
})

describe('Host token budget fold', () => {
  it('aggregates root and descendant suffixes without double-counting inherited seed usage', () => {
    const root = {
      header: { id: 'root' },
      events: [packetEvent, usage(1, 1, 1, 60, 40)],
    }
    const child = {
      header: { id: 'child', parentSession: 'root', seedLength: 2 },
      events: [packetEvent, usage(1, 1, 1, 60, 40), usage(2, 2, 1, 30, 20)],
    }
    const unrelated = {
      header: { id: 'other' },
      events: [packetEvent, usage(1, 1, 1, 999, 999)],
    }

    expect(liveTokenBudgetState([root, child, unrelated], 'root', runId, 150)).toMatchObject({
      usedTokens: 150,
      remainingTokens: 0,
      exhausted: true,
      sessions: 2,
      uncachedInputTokens: 90,
      outputTokens: 60,
    })
  })

  it('replaces a streaming usage sample with the finalized sample for the same step', () => {
    const root = {
      header: { id: 'root' },
      events: [
        packetEvent,
        { type: 'assistant/chunk', seq: 1, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } } } },
        usage(2, 1, 1, 25, 15),
      ],
    }
    expect(liveTokenBudgetState([root], 'root', runId, 100)).toMatchObject({
      usedTokens: 40, exhausted: false, remainingTokens: 60,
    })
  })
})
