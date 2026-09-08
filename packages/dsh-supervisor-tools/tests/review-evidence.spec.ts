import { describe, expect, it } from 'vitest'
import { handoffReviewError, progressPayloadError, supervisorProgressDecision } from '../src/index.js'
import { TASK_PACKET_START, TASK_PACKET_END, reviewEvidenceSchema, reviewWatchPathsSchema } from '../../mcp-server/src/contracts.js'
import { finalReviewError, reviewEvidenceError } from '../src/review-evidence.js'

const evidence = {
  criteria: [{ workstreamId: 'W1', doneWhenIndex: 0, status: 'unknown' as const, evidence: 'The test has not run.' }],
  planChanges: [], negativeEvidence: ['The test has not run.'], evidencePaths: ['src/api.ts'],
  omitted: { criteria: 0, planChanges: 0, negativeEvidence: 0, evidencePaths: 0 },
}
const progress = { phase: 'verifying' as const, milestone: 'Checking API.', nextAction: 'Run tests.', needsSupervisor: false }

describe('bounded review evidence at Host and MCP boundaries', () => {
  it('accepts the same structured claims at both boundaries', () => {
    expect(reviewEvidenceError(evidence)).toBeUndefined()
    expect(reviewEvidenceSchema.safeParse(evidence).success).toBe(true)
    expect(progressPayloadError({ ...progress, reviewEvidence: evidence })).toBeUndefined()
  })
  it('rejects oversized, incomplete, unknown and traversing payloads consistently', () => {
    for (const bad of [
      {}, { ...evidence, extra: 'hidden' }, { ...evidence, negativeEvidence: ['x'.repeat(257)] },
      { ...evidence, criteria: Array(9).fill(evidence.criteria[0]) },
      { ...evidence, evidencePaths: ['../secret'] }, { ...evidence, evidencePaths: ['/private/secret'] },
      { ...evidence, omitted: { ...evidence.omitted, criteria: -1 } },
    ]) {
      expect(reviewEvidenceError(bad)).toBeDefined()
      expect(reviewEvidenceSchema.safeParse(bad).success).toBe(false)
      expect(progressPayloadError({ ...progress, reviewEvidence: bad as never })).toMatch(/reviewEvidence/)
    }
    for (const path of ['/tmp/file', '../file', 'src/../file', 'C:\\secret', './src', 'src//file']) {
      expect(reviewWatchPathsSchema.safeParse([path]).success).toBe(false)
    }
  })
  it('does not deduplicate changed negative evidence just because the milestone is unchanged', () => {
    const first = { ...progress, reviewEvidence: evidence }
    const next = { ...first, reviewEvidence: { ...evidence, negativeEvidence: ['A compatibility test failed.'] } }
    const call = (args: object, time: number) => ({ type: 'tool/call', time, data: { name: 'supervisor_progress', arguments: JSON.stringify(args) } })
    expect(supervisorProgressDecision([call(first, 0), call(next, 61_000)], next, 61_000)).toEqual({ accepted: true })
  })
})

describe('reviewed final evidence admission', () => {
  const streams = [{ id: 'API', doneWhen: ['Contract preserved.', 'Tests pass.'] }]
  const complete = () => ({ ...evidence, negativeEvidence: [], criteria: streams[0]!.doneWhen.map((_, index) => ({
    workstreamId: 'API', doneWhenIndex: index, status: 'met' as const, evidence: 'See src/api.ts and the verification result.',
  })) })
  const events = (mode = 'reviewed', required = true) => [{ type: 'user/message', data: {
    content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify({
      schemaVersion: 2, sessionId: 's1', runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222', objective: 'review', writerMode: 'read_only',
      supervisionMode: mode, ...(required ? { terminalReviewContract: 'criteria-v1' } : {}),
      executionBrief: { workstreams: streams },
    })}\n${TASK_PACKET_END}` }],
  } }]
  it('rejects missing, incomplete, duplicate, foreign, omitted or unresolved completion evidence', () => {
    const good = complete()
    for (const bad of [
      undefined, { ...good, criteria: good.criteria.slice(0, 1) },
      { ...good, criteria: [good.criteria[0], good.criteria[0]] },
      { ...good, criteria: [{ ...good.criteria[0], workstreamId: 'OTHER' }, good.criteria[1]] },
      { ...good, criteria: [{ ...good.criteria[0], status: 'unknown' }, good.criteria[1]] },
      { ...good, criteria: [{ ...good.criteria[0], evidence: '   ' }, good.criteria[1]] },
      { ...good, negativeEvidence: ['Test still fails.'] },
      { ...good, omitted: { ...good.omitted, negativeEvidence: 1 } },
      { ...good, evidencePaths: [] },
    ]) expect(finalReviewError(bad, streams)).toBeDefined()
    expect(finalReviewError(good, streams)).toBeUndefined()
  })
  it('supports all 40 allowed criteria without forcing final evidence into milestone limits', () => {
    const allStreams = Array.from({ length: 5 }, (_, index) => ({ id: `W${index}`, doneWhen: Array(8).fill('verified') }))
    const full = { ...complete(), criteria: allStreams.flatMap(stream => stream.doneWhen.map((_, index) => ({
      workstreamId: stream.id, doneWhenIndex: index, status: 'met' as const, evidence: 'See the verified report.',
    }))) }
    expect(reviewEvidenceError(full)).toBeDefined()
    expect(finalReviewError(full, allStreams)).toBeUndefined()
  })
  it('enforces the durable contract only at successful handoff, preserving light and failure exits', () => {
    expect(handoffReviewError(events(), { status: 'completed' })).toBeDefined()
    expect(handoffReviewError(events(), { status: 'completed', finalReview: complete() })).toBeUndefined()
    expect(handoffReviewError(events('delegated', false), { status: 'completed' })).toBeUndefined()
    expect(handoffReviewError(events('reviewed', false), { status: 'completed' })).toBeUndefined()
    expect(handoffReviewError(events(), { status: 'blocked' })).toBeUndefined()
    expect(handoffReviewError(events(), { status: 'failed' })).toBeUndefined()
  })
})
