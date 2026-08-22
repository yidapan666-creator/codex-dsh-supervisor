import { describe, expect, it } from 'vitest'
import { deriveObservation, progressHeartbeat, progressObservation, timeoutObservation } from '../src/fold.js'
import { TASK_PACKET_END, TASK_PACKET_START, type DshEvent, type TaskRuntimeState } from '../src/contracts.js'

const packet = { schemaVersion: 1, taskId: 's1', completionToken: 'token', objective: 'ship it', writerMode: 'writer' }
const event = (type: string, seq: number, data: unknown): DshEvent => ({ type, seq, time: seq, data })
const start = event('user/message', 0, { content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packet)}\n${TASK_PACKET_END}` }] })
const state = (events: DshEvent[], extra: Partial<TaskRuntimeState> = {}): TaskRuntimeState => ({
  hostInstanceId: 'host-1', events, workerState: 'IDLE', ...extra,
})

function handoffEvents(includeTurnEnd = true): DshEvent[] {
  const args = {
    taskId: 's1', completionToken: 'token', status: 'completed', stage: 'done', summary: 'verified', files: ['a.ts'], verification: [],
  }
  const events = [
    start,
    event('turn/start', 1, { turn: 1 }),
    event('tool/call', 2, { turn: 1, step: 1, callId: 'c1', name: 'supervisor_handoff', arguments: JSON.stringify(args) }),
    event('tool/result', 3, {
      turn: 1, step: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({ accepted: true, artifacts: [] }) }] }] },
    }),
  ]
  if (includeTurnEnd) events.push(event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }))
  return events
}

describe('authoritative completion fold', () => {
  it('requires both a valid handoff result and the corresponding turn end', () => {
    expect(deriveObservation(state(handoffEvents(false))).status).toBe('WAITING')
    const complete = deriveObservation(state(handoffEvents()))
    expect(complete).toMatchObject({ status: 'COMPLETED', boundarySeq: 4, asOfSeq: 4, taskId: 's1' })
  })

  it('never guesses success from turn/end alone', () => {
    const observed = deriveObservation(state([
      start, event('turn/start', 1, { turn: 1 }), event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ]))
    expect(observed.status).toBe('FAILED')
    expect(observed.failure?.kind).toBe('MISSING_HANDOFF')
  })

  it('ignores turn boundaries that predate the latest task packet', () => {
    const observed = deriveObservation(state([
      event('turn/start', 0, { turn: 0 }),
      event('turn/end', 1, { turn: 0, reason: { kind: 'completed' } }),
      { ...start, seq: 2 },
    ]))
    expect(observed.status).toBe('WAITING')
  })

  it('does not reuse an older handoff while a newer supervised turn is open', () => {
    const observed = deriveObservation(state([
      ...handoffEvents(),
      event('turn/start', 5, { turn: 2 }),
    ], { workerState: 'RUNNING' }))
    expect(observed).toMatchObject({ status: 'WAITING', stage: 'running' })
  })

  it('rejects a handoff with the wrong completion token', () => {
    const events = handoffEvents()
    const call = events[2]!
    const data = call.data as { arguments: string }
    data.arguments = JSON.stringify({ ...(JSON.parse(data.arguments) as object), completionToken: 'wrong' })
    expect(deriveObservation(state(events)).failure?.kind).toBe('MISSING_HANDOFF')
  })

  it('surfaces pending interaction ahead of worker state', () => {
    const observed = deriveObservation(state([start], {
      workerState: 'RUNNING',
      pendingApproval: { rpcId: 'r1', approvalId: 'a1', toolName: 'terminal' },
    }))
    expect(observed).toMatchObject({ status: 'APPROVAL_REQUIRED', workerState: 'RUNNING', approval: { rpcId: 'r1' } })
  })

  it('distinguishes pending questions from approvals', () => {
    const observed = deriveObservation(state([start], {
      workerState: 'IDLE',
      pendingQuestion: { rpcId: 'q1', questions: [{ id: 'target' }] },
    }))
    expect(observed).toMatchObject({ status: 'QUESTION_REQUIRED', workerState: 'IDLE', question: { rpcId: 'q1' } })
  })

  it('reports host and protocol failures with explicit kinds', () => {
    expect(deriveObservation(state([start], { hostError: 'agent crashed' }))).toMatchObject({
      status: 'FAILED', failure: { kind: 'HOST_FAILED' },
    })
    expect(deriveObservation(state([]))).toMatchObject({
      status: 'FAILED', failure: { kind: 'PROTOCOL_ERROR' },
    })
  })

  it('surfaces an exhausted reported-failure result as escalation', () => {
    const failureCall = event('tool/call', 2, {
      turn: 1, callId: 'f1', name: 'supervisor_report_failure',
      arguments: JSON.stringify({ failureSignature: 'build:missing-export' }),
    })
    const failureResult = event('tool/result', 3, {
      turn: 1,
      message: {
        source: { callId: 'f1' },
        content: [{ type: 'tool-result', content: [{
          type: 'text', text: JSON.stringify({ exhausted: true, failureSignature: 'build:missing-export', count: 2, budget: 2 }),
        }] }],
      },
    })
    const observed = deriveObservation(state([
      start, event('turn/start', 1, { turn: 1 }), failureCall, failureResult,
      event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
    ]))
    expect(observed).toMatchObject({ status: 'ESCALATION_REQUIRED', failureSignature: 'build:missing-export' })
  })

  it('marks WAITING as an explicit timeout without changing worker state', () => {
    const waiting = deriveObservation(state([start], { workerState: 'RUNNING' }))
    expect(timeoutObservation(waiting, 250)).toMatchObject({
      status: 'WAITING', workerState: 'RUNNING', wait: { reason: 'TIMEOUT', timeoutMs: 250 },
    })
  })

  it('returns a compact progress heartbeat with tool counts and cursor-scoped token deltas', () => {
    const events = [
      start,
      event('turn/start', 1, { turn: 1 }),
      event('step/start', 2, { turn: 1, step: 1 }),
      event('assistant/chunk', 3, {
        turn: 1, step: 1,
        chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20 } },
      }),
      event('assistant/message', 4, {
        turn: 1, step: 1,
        usage: { inputTokens: 12, outputTokens: 6, cacheReadTokens: 20, cacheWriteTokens: 1 },
      }),
      event('tool/call', 5, { turn: 1, step: 1, callId: 'read-1', name: 'read', arguments: '{}' }),
      event('tool/result', 6, { turn: 1, step: 1, message: { source: { callId: 'read-1' }, content: [] } }),
      event('step/end', 7, { turn: 1, step: 1 }),
    ]
    const runtime = state(events, { workerState: 'RUNNING' })
    expect(progressHeartbeat(runtime, 3)).toEqual({
      fromAsOfSeq: 3,
      toAsOfSeq: 7,
      observedEvents: 4,
      steps: { completed: 1, delta: 1 },
      tools: { totalCalls: 1, deltaCalls: 1, deltaByName: { read: 1 } },
      tokenDelta: {
        uncachedInputTokens: 2,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 1,
      },
      lastActivity: { seq: 7, time: 7, kind: 'step', step: 1 },
    })
    expect(progressObservation(deriveObservation(runtime), runtime, 3)).toMatchObject({
      status: 'WAITING', workerState: 'RUNNING', wait: { reason: 'PROGRESS' },
      progress: { fromAsOfSeq: 3, toAsOfSeq: 7, observedEvents: 4 },
    })
  })

  it('does not label an unchanged observation as progress', () => {
    const runtime = state([start], { workerState: 'RUNNING' })
    const observed = progressObservation(deriveObservation(runtime), runtime, 0)
    expect(observed.wait).toBeUndefined()
    expect(timeoutObservation(observed, 50).wait).toEqual({ reason: 'TIMEOUT', timeoutMs: 50 })
  })
})
