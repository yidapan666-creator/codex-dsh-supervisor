import { describe, expect, it } from 'vitest'
import {
  deriveObservation, parseTaskPacket, progressHeartbeat, progressObservation, projectActivityIn,
  recoveryCapsuleForRunTree, timeoutObservation, uncertainEffectsIn,
} from '../src/fold.js'
import {
  HANDOFF_ARTIFACTS_LIMIT, HANDOFF_FILES_LIMIT, HANDOFF_HYPOTHESES_LIMIT, HANDOFF_PATH_LIMIT,
  HANDOFF_VERIFICATION_LIMIT, RECOVERY_CAPSULE_MAX_BYTES, UNCERTAIN_EFFECTS_LIMIT,
  observationSchema, progressHeartbeatSchema,
  TASK_PACKET_END, TASK_PACKET_START, type DshEvent, type TaskRuntimeState,
} from '../src/contracts.js'
import { DEFAULT_DECISION_POLICY } from '@dsh-gate/decision-policy'

const packet = { schemaVersion: 1, taskId: 's1', completionToken: 'token', objective: 'ship it', writerMode: 'writer' }
const event = (type: string, seq: number, data: unknown): DshEvent => ({ type, seq, time: seq, data })
const start = event('user/message', 0, { content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packet)}\n${TASK_PACKET_END}` }] })
const state = (events: DshEvent[], extra: Partial<TaskRuntimeState> = {}): TaskRuntimeState => ({
  hostInstanceId: 'host-1', events, workerState: 'IDLE', ...extra,
})
const codeCall = (seq: number, subCallId: string, name: string, args: object): DshEvent =>
  event('tool/code-dispatch-start', seq, {
    rootCallId: 'run-code-1', parentCallId: 'run-code-1', subCallId, name, arguments: args,
  })
const codeResult = (seq: number, subCallId: string, name: string, args: object, value: unknown, isError = false): DshEvent =>
  event('tool/code-dispatch', seq, {
    rootCallId: 'run-code-1', parentCallId: 'run-code-1', subCallId, name, arguments: args, isError,
    content: [{ type: 'text', text: JSON.stringify(value) }],
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
  it('recognizes an atomically admitted task from the durable inbox before user/message materializes', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'newly admitted',
      writerMode: 'read_only',
    }
    const admitted = event('agent/inbox/spliced', 6, {
      inserted: [{
        id: 'message-1',
        content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
      }],
    })

    expect(deriveObservation(state([admitted], { workerState: 'RUNNING' }))).toMatchObject({
      status: 'WAITING', sessionId: 's1', runId: packetV2.runId, objective: 'newly admitted',
    })
  })

  it('requires both a valid handoff result and the corresponding turn end', () => {
    expect(deriveObservation(state(handoffEvents(false))).status).toBe('WAITING')
    const complete = deriveObservation(state(handoffEvents()))
    expect(complete).toMatchObject({ status: 'COMPLETED', boundarySeq: 4, asOfSeq: 4, taskId: 's1' })
  })

  it('uses the accepted canonical v2 handoff result as the authoritative terminal payload', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'ship it',
      writerMode: 'writer',
    }
    const startV2 = event('user/message', 0, {
      content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
    })
    const callArgs = {
      sessionId: 's1', runId: packetV2.runId, completionToken: packetV2.completionToken,
      status: 'completed', stage: 'untrusted-call-args', summary: 'call args', files: [], verification: [], artifacts: [],
    }
    const canonical = { ...callArgs, stage: 'verified', summary: 'canonical result' }
    const observed = deriveObservation(state([
      startV2,
      event('turn/start', 1, { turn: 1 }),
      event('tool/call', 2, {
        turn: 1, step: 1, callId: 'v2-handoff', name: 'supervisor_handoff', arguments: JSON.stringify(callArgs),
      }),
      event('tool/result', 3, {
        turn: 1, step: 1,
        message: { source: { callId: 'v2-handoff' }, content: [{
          type: 'tool-result',
          content: [{ type: 'text', text: JSON.stringify({ accepted: true, handoff: canonical, artifacts: [] }) }],
        }] },
      }),
      event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
    ]))
    expect(observed).toMatchObject({
      status: 'COMPLETED', sessionId: 's1', runId: packetV2.runId,
      stage: 'verified', summary: 'canonical result',
    })
  })

  it('accepts a valid PTC nested handoff and keeps its durable sub-tool activity visible', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'ship through PTC',
      writerMode: 'writer',
    }
    const startV2 = event('user/message', 0, {
      content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
    })
    const handoff = {
      sessionId: packetV2.sessionId,
      runId: packetV2.runId,
      completionToken: packetV2.completionToken,
      status: 'completed', stage: 'done', summary: 'PTC verified', files: ['src/a.ts'], verification: [], artifacts: [],
    }
    const observed = deriveObservation(state([
      startV2,
      event('turn/start', 1, { turn: 1 }),
      event('tool/call', 2, {
        turn: 1, step: 1, callId: 'run-code-1', name: 'run_code',
        arguments: JSON.stringify({ code: 'await tools.supervisor_handoff(...)', description: 'finish' }),
      }),
      codeCall(3, 'run-code-1:code:1', 'supervisor_handoff', handoff),
      codeResult(4, 'run-code-1:code:1', 'supervisor_handoff', handoff, {
        accepted: true, handoff, artifacts: [],
      }),
      event('tool/result', 5, {
        turn: 1, step: 1,
        message: { source: { callId: 'run-code-1' }, content: [{ type: 'tool-result', isError: false, content: [] }] },
      }),
      event('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }),
    ]))

    expect(observed).toMatchObject({
      status: 'COMPLETED', stage: 'done', summary: 'PTC verified',
      projectActivity: {
        toolCalls: 2,
        toolCallsByName: { run_code: 1, supervisor_handoff: 1 },
      },
    })
  })

  it('bounds every worker-controlled handoff collection before returning it to Codex', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'ship it',
      writerMode: 'writer',
    }
    const startV2 = event('user/message', 0, {
      content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
    })
    const manifest = Array.from({ length: HANDOFF_ARTIFACTS_LIMIT + 1 }, (_, index) => ({
      path: `${String(index)}.md`, bytes: 1, sha256: 'a'.repeat(64),
    }))
    const canonical = {
      sessionId: packetV2.sessionId,
      runId: packetV2.runId,
      completionToken: packetV2.completionToken,
      status: 'completed',
      stage: 's'.repeat(1_000),
      summary: 'x'.repeat(4_000),
      files: Array.from({ length: HANDOFF_FILES_LIMIT + 1 }, () => 'f'.repeat(HANDOFF_PATH_LIMIT + 1)),
      verification: Array.from({ length: HANDOFF_VERIFICATION_LIMIT + 1 }, () => ({
        command: 'c'.repeat(1_000), outcome: 'passed', summary: 'v'.repeat(1_000),
      })),
      blocker: 'b'.repeat(2_000),
      failureSignature: 'e'.repeat(1_000),
      attemptedHypotheses: Array.from({ length: HANDOFF_HYPOTHESES_LIMIT + 1 }, () => 'h'.repeat(1_000)),
    }
    const observed = deriveObservation(state([
      startV2,
      event('turn/start', 1, { turn: 1 }),
      event('tool/call', 2, {
        turn: 1, step: 1, callId: 'large-handoff', name: 'supervisor_handoff', arguments: JSON.stringify(canonical),
      }),
      event('tool/result', 3, {
        turn: 1, step: 1,
        message: { source: { callId: 'large-handoff' }, content: [{
          type: 'tool-result',
          content: [{ type: 'text', text: JSON.stringify({ accepted: true, handoff: canonical, artifacts: manifest }) }],
        }] },
      }),
      event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
    ]))

    expect(observed.status).toBe('COMPLETED')
    expect(observed.files).toHaveLength(HANDOFF_FILES_LIMIT)
    expect(observed.files[0]).toHaveLength(HANDOFF_PATH_LIMIT)
    expect(observed.verification).toHaveLength(HANDOFF_VERIFICATION_LIMIT)
    expect(observed.attemptedHypotheses).toHaveLength(HANDOFF_HYPOTHESES_LIMIT)
    expect(observed.artifacts).toHaveLength(HANDOFF_ARTIFACTS_LIMIT)
    expect(observed.handoffTruncated?.fields).toEqual(expect.arrayContaining([
      'stage', 'summary', 'files', 'verification', 'blocker', 'failureSignature', 'attemptedHypotheses', 'artifacts',
    ]))
    expect(observationSchema.safeParse(observed).success).toBe(true)
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
      projectActivity: {
        coverage: 'complete',
        edits: { total: 0, files: [] },
        verification: { total: 0, commands: [], evidence: [] },
      },
      lastActivity: { seq: 7, time: 7, kind: 'step', step: 1 },
    })
    expect(progressObservation(deriveObservation(runtime), runtime, 3)).toMatchObject({
      status: 'WAITING', workerState: 'RUNNING', wait: { reason: 'PROGRESS' },
      progress: { fromAsOfSeq: 3, toAsOfSeq: 7, observedEvents: 4 },
    })
  })

  it('folds accepted bounded semantic progress into an ordinary running observation', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'ship it',
      writerMode: 'writer',
    }
    const progress = {
      sessionId: 's1', runId: packetV2.runId, phase: 'implementing',
      milestone: 'Parser changes are in place.', nextAction: 'Run focused tests.', needsSupervisor: false,
    }
    const observed = deriveObservation(state([
      event('user/message', 0, {
        content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
      }),
      event('turn/start', 1, { turn: 1 }),
      event('tool/call', 2, {
        turn: 1, callId: 'p1', name: 'supervisor_progress', arguments: JSON.stringify(progress),
      }),
      event('tool/result', 3, {
        turn: 1,
        message: { source: { callId: 'p1' }, content: [{ type: 'tool-result', content: [{
          type: 'text', text: JSON.stringify({ accepted: true, progress }),
        }] }] },
      }),
    ], { workerState: 'RUNNING' }))

    expect(observed).toMatchObject({
      status: 'WAITING', stage: 'running',
      supervisorProgress: { phase: 'implementing', milestone: 'Parser changes are in place.', needsSupervisor: false },
    })
  })

  it('returns early when bounded semantic progress requests a supervisor decision', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'ship it',
      writerMode: 'writer',
    }
    const progress = {
      sessionId: 's1', runId: packetV2.runId, phase: 'investigating',
      milestone: 'Two incompatible migration paths remain.', nextAction: 'Choose the compatibility policy.',
      risk: 'The choice changes the public API.', needsSupervisor: true,
      decision: {
        category: 'acceptance', impact: 'medium', blocking: true,
        request: 'Choose the compatibility policy.', options: ['strict', 'compatible'], recommendation: 'compatible',
      },
    }
    const shadow = {
      ...DEFAULT_DECISION_POLICY,
      version: 'shadow.test',
      workerRules: [],
      workerFallback: {
        timing: 'cadence' as const, audience: 'supervisor' as const,
        action: 'SURFACE_PROGRESS' as const, reasonCode: 'SHADOW_WOULD_WAIT',
      },
    }
    const observed = deriveObservation(state([
      event('user/message', 0, {
        content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
      }),
      event('turn/start', 1, { turn: 1 }),
      event('tool/call', 2, {
        turn: 1, callId: 'p1', name: 'supervisor_progress', arguments: JSON.stringify(progress),
      }),
      event('tool/result', 3, {
        turn: 1,
        message: { source: { callId: 'p1' }, content: [{ type: 'tool-result', content: [{
          type: 'text', text: JSON.stringify({ accepted: true, progress }),
        }] }] },
      }),
    ], { workerState: 'RUNNING' }), DEFAULT_DECISION_POLICY, shadow)

    expect(observed).toMatchObject({
      status: 'SUPERVISOR_REQUIRED', boundarySeq: 3, stage: 'investigating',
      supervisorProgress: { needsSupervisor: true, nextAction: 'Choose the compatibility policy.' },
      decision: {
        timing: 'immediate', audience: 'human', action: 'ASK_HUMAN',
        matchedRuleId: 'worker.sensitive', reasonCode: 'SENSITIVE_OR_SCOPE_DECISION',
      },
      decisionShadow: {
        timing: 'cadence', action: 'SURFACE_PROGRESS', reasonCode: 'SHADOW_WOULD_WAIT', differs: true,
      },
    })
    expect(() => observationSchema.parse(observed)).not.toThrow()
  })

  it('keeps a low-impact non-blocking worker request in the ordinary cadence', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'ship it',
      writerMode: 'writer',
    }
    const progress = {
      sessionId: 's1', runId: packetV2.runId, phase: 'implementing',
      milestone: 'Naming can be improved.', nextAction: 'Continue with the recommended local name.',
      needsSupervisor: true,
      decision: {
        category: 'information', impact: 'low', blocking: false,
        request: 'Review the local helper name at the next cadence.', recommendation: 'Use decisionFacts.',
      },
    }
    const observed = deriveObservation(state([
      event('user/message', 0, {
        content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
      }),
      event('turn/start', 1, { turn: 1 }),
      event('tool/call', 2, { turn: 1, callId: 'p1', name: 'supervisor_progress', arguments: JSON.stringify(progress) }),
      event('tool/result', 3, {
        turn: 1,
        message: { source: { callId: 'p1' }, content: [{ type: 'tool-result', content: [{
          type: 'text', text: JSON.stringify({ accepted: true, progress }),
        }] }] },
      }),
    ], { workerState: 'RUNNING' }))

    expect(observed).toMatchObject({
      status: 'WAITING',
      decision: {
        timing: 'cadence', audience: 'supervisor', action: 'SURFACE_PROGRESS',
        matchedRuleId: 'worker.fallback', reasonCode: 'NON_BLOCKING_WORKER_DECISION',
      },
    })
  })

  it('does not repeat a supervisor-requested boundary after later supervisor guidance', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'ship it',
      writerMode: 'writer',
    }
    const progress = {
      sessionId: 's1', runId: packetV2.runId, phase: 'investigating',
      milestone: 'A policy choice is required.', nextAction: 'Choose one.', needsSupervisor: true,
    }
    const observed = deriveObservation(state([
      event('user/message', 0, {
        content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
      }),
      event('turn/start', 1, { turn: 1 }),
      event('tool/call', 2, {
        turn: 1, callId: 'p1', name: 'supervisor_progress', arguments: JSON.stringify(progress),
      }),
      event('tool/result', 3, {
        turn: 1,
        message: { source: { callId: 'p1' }, content: [{ type: 'tool-result', content: [{
          type: 'text', text: JSON.stringify({ accepted: true, progress }),
        }] }] },
      }),
      event('user/message', 4, { content: [{ type: 'text', text: 'Keep the compatibility layer for one release.' }] }),
    ], { workerState: 'RUNNING' }))

    expect(observed).toMatchObject({
      status: 'WAITING', stage: 'running',
      decision: { timing: 'cadence', matchedRuleId: 'protocol.progress' },
    })
  })

  it('does not label an unchanged observation as progress', () => {
    const runtime = state([start], { workerState: 'RUNNING' })
    const observed = progressObservation(deriveObservation(runtime), runtime, 0)
    expect(observed.wait).toBeUndefined()
    expect(timeoutObservation(observed, 50).wait).toEqual({ reason: 'TIMEOUT', timeoutMs: 50 })
  })
})

describe('project activity summarization', () => {
  const toolCall = (seq: number, callId: string, name: string, args: object): DshEvent =>
    event('tool/call', seq, { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
  const toolResult = (seq: number, callId: string, ok = true): DshEvent =>
    event('tool/result', seq, {
      turn: 1, step: 1,
      message: { source: { callId }, content: [{ type: 'tool-result', isError: !ok, content: [] }] },
    })

  it('counts distinct successful edit/write paths and targeted verification commands', () => {
    const events = [
      toolCall(1, 'e1', 'edit', { file_path: 'packages/a/src/x.ts', old_string: 'a', new_string: 'b' }),
      toolResult(2, 'e1'),
      toolCall(3, 'e2', 'write', { file_path: 'packages/a/src/y.ts', content: 'body' }),
      toolResult(4, 'e2'),
      toolCall(5, 'e3', 'edit', { file_path: 'packages/a/src/x.ts', old_string: 'b', new_string: 'c' }),
      toolResult(6, 'e3'),
      // A failed edit is a tool call but not a project change.
      toolCall(7, 'e4', 'edit', { file_path: 'packages/b/broken.ts', old_string: 'x', new_string: 'y' }),
      toolResult(8, 'e4', false),
      toolCall(9, 'v1', 'bash', { command: 'pnpm verify' }),
      toolResult(10, 'v1'),
      toolCall(11, 'v2', 'bash', { command: 'vitest run packages/a' }),
      toolResult(12, 'v2'),
      // git status is not targeted verification.
      toolCall(13, 'v3', 'bash', { command: 'git status' }),
      toolResult(14, 'v3'),
      // Reads are not project changes.
      toolCall(15, 'r1', 'read', { file_path: 'packages/a/src/x.ts' }),
      toolResult(16, 'r1'),
      event('step/end', 17, { turn: 1, step: 2 }),
    ]
    const activity = projectActivityIn(events, 1, 17)
    expect(activity.edits).toEqual({ total: 2, files: ['packages/a/src/x.ts', 'packages/a/src/y.ts'] })
    expect(activity.verification).toEqual({
      total: 2,
      commands: ['pnpm verify', 'vitest run'],
      evidence: [
        { command: 'pnpm verify', outcome: 'passed' },
        { command: 'vitest run', outcome: 'passed' },
      ],
    })
    expect(activity.steps).toBe(1)
    expect(activity.toolCalls).toBe(8)
    expect(activity.toolCallsByName).toEqual({ edit: 3, write: 1, bash: 3, read: 1 })
    expect(activity.coverage).toBe('partial')
    expect(activity.tokenUsage).toEqual({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('counts str_replace_editor mutations but not views as edits', () => {
    const events = [
      toolCall(1, 's1', 'str_replace_editor', { command: 'str_replace', path: 'src/main.ts', old_str: 'a', new_str: 'b' }),
      toolResult(2, 's1'),
      toolCall(3, 's2', 'str_replace_editor', { command: 'view', path: 'src/main.ts' }),
      toolResult(4, 's2'),
      toolCall(5, 's3', 'str_replace_editor', { command: 'create', path: 'src/new.ts', file_text: 'x' }),
      toolResult(6, 's3'),
    ]
    const activity = projectActivityIn(events, 1, 6)
    expect(activity.edits).toEqual({ total: 2, files: ['src/main.ts', 'src/new.ts'] })
    expect(activity.toolCalls).toBe(3)
  })

  it('classifies PTC SDK sub-dispatch edits and verification by their real tool names', () => {
    const editArgs = { file_path: '/repo/src/ptc.ts', old_string: 'a', new_string: 'b' }
    const verifyArgs = { command: 'pnpm verify' }
    const events = [
      codeCall(1, 'run-code-1:code:1', 'edit', editArgs),
      codeResult(2, 'run-code-1:code:1', 'edit', editArgs, { ok: true }),
      codeCall(3, 'run-code-1:code:2', 'bash', verifyArgs),
      codeResult(4, 'run-code-1:code:2', 'bash', verifyArgs, { ok: true }),
    ]

    expect(projectActivityIn(events, 1, 4, '/repo')).toMatchObject({
      coverage: 'partial',
      edits: { total: 1, files: ['src/ptc.ts'] },
      verification: {
        total: 1, commands: ['pnpm verify'], evidence: [{ command: 'pnpm verify', outcome: 'passed' }],
      },
      toolCalls: 2,
      toolCallsByName: { edit: 1, bash: 1 },
    })
  })

  it('tracks an unsettled PTC effect and clears it only after the durable nested result', () => {
    const args = { file_path: '/repo/src/ptc.ts', old_string: 'a', new_string: 'b' }
    const started = codeCall(1, 'run-code-1:code:1', 'edit', args)

    expect(uncertainEffectsIn([started], 1, 1)).toMatchObject({
      total: 1,
      entries: [{
        callId: 'run-code-1:code:1', toolName: 'edit', category: 'FILESYSTEM_MUTATION',
        reason: 'NO_DURABLE_TOOL_RESULT', replayGuidance: 'RECONCILE_BEFORE_RETRY',
      }],
    })
    expect(uncertainEffectsIn([
      started,
      codeResult(2, 'run-code-1:code:1', 'edit', args, { ok: true }),
    ], 1, 2)).toMatchObject({ total: 0, entries: [] })
  })

  it('fails closed on result blocks marked isError even without a top-level error', () => {
    const events = [
      toolCall(1, 'e1', 'edit', { file_path: 'src/rejected.ts', old_string: 'a', new_string: 'b' }),
      toolResult(2, 'e1', false),
    ]
    expect(projectActivityIn(events, 1, 2).edits).toEqual({ total: 0, files: [] })
  })

  it('labels incomplete tool classification as partial and correlates failed verification evidence', () => {
    const events = [
      toolCall(1, 'custom-1', 'project_codegen', { target: 'src/generated.ts' }),
      toolResult(2, 'custom-1'),
      toolCall(3, 'verify-1', 'bash', { command: 'pytest' }),
      toolResult(4, 'verify-1', false),
      toolCall(5, 'verify-2', 'bash', { command: 'eslint src' }),
      event('tool/result', 6, {
        message: { source: { callId: 'verify-2' }, content: [{ type: 'tool-result', content: [] }] },
      }),
    ]
    const activity = projectActivityIn(events, 1, 6)
    expect(activity.coverage).toBe('partial')
    expect(activity.edits).toEqual({ total: 0, files: [] })
    expect(activity.verification.evidence).toEqual([
      { command: 'pytest', outcome: 'failed' },
      { command: 'eslint', outcome: 'pending' },
    ])
  })

  it('keeps surfaced edit paths relative to the authoritative cwd and rejects escapes', () => {
    const events = [
      toolCall(1, 'e1', 'edit', { file_path: '/repo/src/inside.ts', old_string: 'a', new_string: 'b' }),
      toolResult(2, 'e1'),
      toolCall(3, 'e2', 'edit', { file_path: '../outside.ts', old_string: 'a', new_string: 'b' }),
      toolResult(4, 'e2'),
      toolCall(5, 'e3', 'write', { file_path: '/private/secret.txt', content: 'x' }),
      toolResult(6, 'e3'),
    ]
    expect(projectActivityIn(events, 1, 6, '/repo').edits).toEqual({
      total: 1,
      files: ['src/inside.ts'],
    })
  })

  it('caps the surfaced file and command samples while keeping totals', () => {
    const events: DshEvent[] = []
    for (let index = 1; index <= 12; index++) {
      events.push(toolCall(index * 2 - 1, `e${index}`, 'edit', { file_path: `src/file${index}.ts`, old_string: 'a', new_string: 'b' }))
      events.push(toolResult(index * 2, `e${index}`))
    }
    const activity = projectActivityIn(events, 1, 24)
    expect(activity.edits.total).toBe(12)
    expect(activity.edits.files).toHaveLength(10)
  })

  it('sanitizes labels: control characters stripped and labels bounded', () => {
    const events = [
      toolCall(1, 'e1', 'edit', { file_path: 'src/bad\npath\u0000.ts', old_string: 'a', new_string: 'b' }),
      toolResult(2, 'e1'),
      toolCall(3, 'v1', 'bash', { command: `pnpm verify ${'x'.repeat(200)}` }),
      toolResult(4, 'v1'),
    ]
    const activity = projectActivityIn(events, 1, 4)
    expect(activity.edits.files).toEqual(['src/bad path .ts'])
    expect(activity.verification.commands).toEqual(['pnpm verify'])
  })

  it('scopes the heartbeat project activity to the delta window', () => {
    const events = [
      start,
      toolCall(1, 'e1', 'edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
      toolResult(2, 'e1'),
      toolCall(3, 'e2', 'write', { file_path: 'b.ts', content: 'z' }),
      toolResult(4, 'e2'),
    ]
    const runtime = state(events, { workerState: 'RUNNING' })
    const heartbeat = progressHeartbeat(runtime, 2)
    expect(heartbeat.projectActivity).toEqual({
      coverage: 'complete',
      edits: { total: 1, files: ['b.ts'] },
      verification: { total: 0, commands: [], evidence: [] },
    })
  })

  it('attaches task-scope project activity to a terminal handoff observation', () => {
    const events = [
      start,
      event('turn/start', 1, { turn: 1 }),
      toolCall(2, 'e1', 'edit', { file_path: 'src/gateway.ts', old_string: 'a', new_string: 'b' }),
      toolResult(3, 'e1'),
      toolCall(4, 'v1', 'bash', { command: 'pnpm verify' }),
      toolResult(5, 'v1'),
      event('tool/call', 6, {
        turn: 1, step: 2, callId: 'h1', name: 'supervisor_handoff',
        arguments: JSON.stringify({ taskId: 's1', completionToken: 'token', status: 'completed', stage: 'done', summary: 'verified', files: ['src/gateway.ts'], verification: [] }),
      }),
      event('tool/result', 7, {
        turn: 1, step: 2,
        message: { source: { callId: 'h1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({ accepted: true, artifacts: [] }) }] }] },
      }),
      event('turn/end', 8, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const observed = deriveObservation(state(events))
    expect(observed.status).toBe('COMPLETED')
    expect(observed.projectActivity).toMatchObject({
      coverage: 'partial',
      edits: { total: 1, files: ['src/gateway.ts'] },
      verification: {
        total: 1, commands: ['pnpm verify'], evidence: [{ command: 'pnpm verify', outcome: 'passed' }],
      },
      steps: 0,
      toolCalls: 3,
      toolCallsByName: { edit: 1, bash: 1, supervisor_handoff: 1 },
    })
  })

  it('keeps heartbeat and terminal observations valid against the MCP output schemas', () => {
    const runtime = state(handoffEvents(), { workerState: 'IDLE' })
    expect(progressHeartbeatSchema.safeParse(progressHeartbeat(runtime, 0)).success).toBe(true)
    expect(observationSchema.safeParse(deriveObservation(runtime)).success).toBe(true)
    expect(observationSchema.safeParse(progressObservation(deriveObservation(runtime), runtime, 0)).success).toBe(true)
  })

  it('surfaces Host-enforced run-tree token budget exhaustion as escalation', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'bounded work',
      writerMode: 'writer',
      budget: { maxTokens: 100 },
    }
    const observed = deriveObservation(state([
      event('user/message', 0, {
        content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
      }),
      event('turn/start', 1, { turn: 1 }),
      event('assistant/message', 2, {
        turn: 1, step: 1, usage: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10 },
      }),
      event('turn/end', 3, {
        turn: 1,
        reason: { kind: 'aborted', reason: { kind: 'hook', reason: `dsh-gate:token-budget-exhausted;runId=${packetV2.runId};used=130;limit=100` } },
      }),
    ]))
    expect(observed).toMatchObject({
      status: 'ESCALATION_REQUIRED',
      stage: 'token-budget-exhausted',
      budget: {
        limitTokens: 100, observedTokens: 130, remainingTokens: 0,
        exhausted: true, coverage: 'run_tree', enforcement: 'DSH_HOST_RUNTIME',
      },
    })
    expect(observationSchema.safeParse(observed).success).toBe(true)
  })

  it('distinguishes a request that cannot fit from already-consumed budget exhaustion', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'bounded work',
      writerMode: 'read_only',
      budget: { maxTokens: 8_000 },
    }
    const observed = deriveObservation(state([
      event('user/message', 0, {
        content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
      }),
      event('turn/start', 1, { turn: 1 }),
      event('turn/end', 2, {
        turn: 1,
        reason: { kind: 'aborted', reason: { kind: 'hook', reason: `dsh-gate:token-budget-request-rejected;runId=${packetV2.runId};used=0;limit=8000;remaining=8000;requiredInput=12000` } },
      }),
    ]))
    expect(observed).toMatchObject({
      status: 'ESCALATION_REQUIRED',
      stage: 'token-budget-request-rejected',
      budget: {
        limitTokens: 8_000, observedTokens: 0, remainingTokens: 8_000,
        exhausted: false, coverage: 'run_tree',
      },
    })
    expect(observed.summary).toContain('12000 input tokens required')
  })

  it('requires an explicit continuation after Host crash recovery interrupts a turn', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'recoverable work',
      writerMode: 'writer',
    }
    const observed = deriveObservation(state([
      event('user/message', 0, {
        content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
      }),
      event('turn/start', 1, { turn: 1 }),
      event('turn/end', 2, { turn: 1, reason: { kind: 'interrupted' } }),
    ]))
    expect(observed).toMatchObject({
      status: 'FAILED',
      stage: 'host-restart-interrupted',
      failure: { kind: 'HOST_FAILED', retryable: true },
      recovery: { kind: 'CONTINUATION_REQUIRED', parentRunId: packetV2.runId },
    })
  })

  it('builds a bounded recovery capsule and records only unresolved side-effecting calls', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'continue safely after a Host restart',
      writerMode: 'writer',
      baseline: { head: 'abc123', statusSummary: 'M existing-user-file.ts' },
      budget: { maxTokens: 10_000 },
    }
    const progress = {
      sessionId: 's1', runId: packetV2.runId, phase: 'implementing',
      milestone: 'updated the parser', nextAction: 'run focused tests',
      currentHypothesis: 'the parser now preserves the boundary', needsSupervisor: false,
    }
    const runtime = state([
      event('user/message', 0, {
        content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
      }),
      event('turn/start', 1, { turn: 1 }),
      event('tool/call', 2, {
        turn: 1, step: 1, callId: 'progress-1', name: 'supervisor_progress', arguments: JSON.stringify(progress),
      }),
      event('tool/result', 3, {
        turn: 1, step: 1,
        message: { source: { callId: 'progress-1' }, content: [{ type: 'tool-result', content: [{
          type: 'text', text: JSON.stringify({ accepted: true, progress }),
        }] }] },
      }),
      event('tool/call', 4, {
        turn: 1, step: 2, callId: 'resolved-write', name: 'write',
        arguments: JSON.stringify({ file_path: '/work/already-written.ts', content: 'secret output' }),
      }),
      event('tool/result', 5, {
        turn: 1, step: 2, message: { source: { callId: 'resolved-write' }, content: [] },
      }),
      event('tool/call', 6, {
        turn: 1, step: 3, callId: 'safe-read', name: 'read', arguments: JSON.stringify({ path: '/work/input.ts' }),
      }),
      event('tool/call', 7, {
        turn: 1, step: 4, callId: 'uncertain-edit', name: 'edit',
        arguments: JSON.stringify({ file_path: '/work/maybe-edited.ts', replacement: 'private source text' }),
      }),
      event('tool/call', 8, {
        turn: 1, step: 5, callId: 'uncertain-command', name: 'bash',
        arguments: JSON.stringify({ command: 'curl -X POST https://example.invalid/private' }),
      }),
      event('assistant/message', 9, {
        turn: 1, step: 5, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
      }),
      event('turn/end', 10, { turn: 1, reason: { kind: 'interrupted' } }),
    ], { cwd: '/work' })
    const observed = deriveObservation(runtime)
    const parsed = parseTaskPacket(runtime.events)
    const terminal = runtime.events.at(-1)
    if (parsed?.schemaVersion !== 2 || terminal === undefined) throw new Error('expected v2 recovery fixture')
    const capsule = recoveryCapsuleForRunTree(runtime, parsed, terminal)

    expect(observed.recoveryCapsule).toBeUndefined()
    expect(capsule).toMatchObject({
      schemaVersion: 1,
      modelCallsUsed: 0,
      maxBytes: RECOVERY_CAPSULE_MAX_BYTES,
      parentRunId: packetV2.runId,
      interruption: { kind: 'HOST_RESTART_INTERRUPTED', boundarySeq: 10 },
      lastAcceptedProgress: { milestone: 'updated the parser', nextAction: 'run focused tests' },
      workspace: {
        baseline: { head: 'abc123', statusSummary: 'M existing-user-file.ts' },
      },
      uncertainEffects: {
        total: 2,
        entries: [
          { callId: 'uncertain-edit', toolName: 'edit', category: 'FILESYSTEM_MUTATION' },
          { callId: 'uncertain-command', toolName: 'bash', category: 'COMMAND_OR_EXTERNAL_EFFECT' },
        ],
      },
      continuation: {
        action: 'RECONCILE_UNCERTAIN_EFFECTS_THEN_CONTINUE',
        replayPolicy: 'DO_NOT_BLINDLY_REPLAY',
      },
    })
    expect(capsule.byteLength).toBeLessThanOrEqual(RECOVERY_CAPSULE_MAX_BYTES)
    expect(JSON.stringify(capsule)).not.toContain('private source text')
    expect(JSON.stringify(capsule)).not.toContain('example.invalid')
    expect(observationSchema.safeParse(observed).success).toBe(true)
  })

  it('caps the uncertain-effect ledger without losing the total count', () => {
    const packetV2 = {
      schemaVersion: 2,
      sessionId: 's1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'bounded recovery evidence',
      writerMode: 'writer',
    }
    const calls = Array.from({ length: UNCERTAIN_EFFECTS_LIMIT + 5 }, (_, index) => event('tool/call', index + 2, {
      turn: 1, step: index + 1, callId: `effect-${String(index)}`, name: 'unknown_mutator',
      arguments: JSON.stringify({ secret: 'must never enter the capsule' }),
    }))
    const runtime = state([
      event('user/message', 0, {
        content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packetV2)}\n${TASK_PACKET_END}` }],
      }),
      event('turn/start', 1, { turn: 1 }),
      ...calls,
      event('turn/end', calls.length + 2, { turn: 1, reason: { kind: 'interrupted' } }),
    ])
    const observed = deriveObservation(runtime)
    const parsed = parseTaskPacket(runtime.events)
    const terminal = runtime.events.at(-1)
    if (parsed?.schemaVersion !== 2 || terminal === undefined) throw new Error('expected v2 recovery fixture')
    const capsule = recoveryCapsuleForRunTree(runtime, parsed, terminal)

    expect(observed.recoveryCapsule).toBeUndefined()
    expect(capsule.uncertainEffects).toMatchObject({
      total: UNCERTAIN_EFFECTS_LIMIT + 5,
      truncated: true,
    })
    expect(capsule.uncertainEffects.entries).toHaveLength(UNCERTAIN_EFFECTS_LIMIT)
    expect(capsule.byteLength).toBeLessThanOrEqual(RECOVERY_CAPSULE_MAX_BYTES)
  })
})
