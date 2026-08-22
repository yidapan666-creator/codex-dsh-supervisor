import { describe, expect, it } from 'vitest'
import { reportedFailureDecision } from '../src/index.js'

function report(signature: string): { type: string; data: unknown } {
  return {
    type: 'tool/call',
    data: {
      name: 'supervisor_report_failure',
      arguments: JSON.stringify({ failureSignature: signature }),
    },
  }
}

const taskPacket = {
  type: 'user/message',
  data: { content: [{ type: 'text', text: '<dsh-supervised-task>\n{}\n</dsh-supervised-task>' }] },
}

describe('reported failure budget', () => {
  it('forces escalation on the second exact worker-reported signature', () => {
    const result = reportedFailureDecision([report('build:missing-export'), report('build:missing-export')], 'build:missing-export', 2)
    expect(result).toEqual({ count: 2, exhausted: true })
  })

  it('does not infer semantic similarity between differently reported signatures', () => {
    const result = reportedFailureDecision([report('build:missing-export'), report('build:other-wording')], 'build:missing-export', 2)
    expect(result).toEqual({ count: 1, exhausted: false })
  })

  it('resets accounting at the latest durable supervised task packet', () => {
    const result = reportedFailureDecision([
      report('build:missing-export'),
      taskPacket,
      report('build:missing-export'),
    ], 'build:missing-export', 2)
    expect(result).toEqual({ count: 1, exhausted: false })
  })
})
