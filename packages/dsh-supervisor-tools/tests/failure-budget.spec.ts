import { describe, expect, it } from 'vitest'
import {
  reportedFailureDecision, reportedFailureIdentityError, reportedFailurePayloadError,
} from '../src/index.js'

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

function addressedPacket(sessionId: string): { type: string; data: unknown } {
  return {
    type: 'user/message',
    data: { content: [{ type: 'text', text: `<dsh-supervised-task>\n${JSON.stringify({
      schemaVersion: 1, taskId: sessionId, completionToken: 'token', objective: 'repair', writerMode: 'writer',
    })}\n</dsh-supervised-task>` }] },
  }
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

  it('bounds every worker-authored reported failure field', () => {
    expect(reportedFailurePayloadError({
      failureSignature: 'x'.repeat(257), summary: 'failed', hypothesis: 'retry',
    })).toMatch(/failureSignature exceeds 256/)
    expect(reportedFailurePayloadError({
      failureSignature: 'build:missing-export', summary: 'x'.repeat(1_025), hypothesis: 'retry',
    })).toMatch(/summary exceeds 1024/)
    expect(reportedFailurePayloadError({
      failureSignature: 'build:missing-export', summary: 'failed', hypothesis: 'x'.repeat(513),
    })).toMatch(/hypothesis exceeds 512/)
  })

  it('rejects failure-budget authority from an inherited or wrong session', () => {
    expect(reportedFailureIdentityError([addressedPacket('root')], 'child')).toMatch(/Root-only/)
    expect(reportedFailureIdentityError([addressedPacket('root')], 'root')).toBeUndefined()
    expect(reportedFailureIdentityError([], 'root')).toMatch(/valid supervised task packet/)
  })
})
