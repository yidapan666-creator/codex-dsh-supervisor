import { afterEach, describe, expect, it, vi } from 'vitest'
import { awaitSupervisorReview } from '../../dsh-supervisor-tools/src/review-checkpoint.js'
import { deriveObservation, progressObservation } from '../src/fold.js'
import { GatewayManager } from '../src/gateway.js'
import { EXPECTED_GATE_BUILD_ID, HostConnection } from '../src/host.js'
import {
  observationSchema, TASK_PACKET_END, TASK_PACKET_START,
  type DshEvent, type TaskRuntimeState,
} from '../src/contracts.js'
import { FakeApi } from './host.fake.js'

const packet = {
  schemaVersion: 2, sessionId: 's1',
  runId: '11111111-1111-4111-8111-111111111111',
  completionToken: '22222222-2222-4222-8222-222222222222',
  objective: 'Review a synthetic fixture', writerMode: 'writer', supervisionMode: 'reviewed',
}
const event = (type: string, seq: number, data: unknown): DshEvent => ({ type, seq, time: seq * 61_000, data })
const initial = (overrides: object = {}): DshEvent[] => [
  event('user/message', 0, { content: [{
    type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify({ ...packet, ...overrides })}\n${TASK_PACKET_END}`,
  }] }),
  event('turn/start', 1, { turn: 1 }),
]
const risk = {
  sessionId: packet.sessionId, runId: packet.runId, phase: 'implementing',
  milestone: 'Detected a material risk.', nextAction: 'Review the risk.',
  needsSupervisor: false, riskLevel: 'critical', risk: 'Public contract may break.',
}
const result = (seq: number, callId: string, value: object): DshEvent => event('tool/result', seq, {
  turn: 1, message: { source: { callId }, content: [{
    type: 'tool-result', isError: false, content: [{ type: 'text', text: JSON.stringify(value) }],
  }] },
})
const progress = (seq: number, payload: object = risk): DshEvent[] => [
  event('tool/call', seq, { turn: 1, callId: `p${seq}`, name: 'supervisor_progress', arguments: JSON.stringify(payload) }),
  result(seq + 1, `p${seq}`, { accepted: true, progress: payload }),
]
const end = (seq: number, kind = 'completed'): DshEvent => event('turn/end', seq, { turn: 1, reason: { kind } })
const handoff = (): DshEvent[] => {
  const args = {
    sessionId: packet.sessionId, runId: packet.runId, completionToken: packet.completionToken,
    status: 'completed', stage: 'done', summary: 'Fixture finished.', files: [], verification: [],
  }
  return [
    event('tool/call', 6, { turn: 1, callId: 'handoff', name: 'supervisor_handoff', arguments: JSON.stringify(args) }),
    result(7, 'handoff', { accepted: true, handoff: args, artifacts: [] }), end(8),
  ]
}
const state = (events: DshEvent[], extra: Partial<TaskRuntimeState> = {}): TaskRuntimeState => ({
  hostInstanceId: 'fake', events, workerState: 'RUNNING', ...extra,
})
const managers: GatewayManager[] = []
afterEach(() => { for (const manager of managers) manager.stopClients() })

function managerWith(api: FakeApi): GatewayManager {
  const manager = new GatewayManager({ hostUrls: ['http://fixture'], runJournal: false }, {
    resolveWriterDomain: async () => '/fixture',
    createConnection: () => new HostConnection(
      'http://fixture', api.api, request => api.admitTask(request),
      request => api.tokenBudgetState(request), request => api.recoveryCapsule(request),
      async () => ({
        schemaVersion: 1, gateProtocolVersion: 1, pluginName: '@dsh-gate/supervisor-tools',
        pluginVersion: '0.1.0', buildId: EXPECTED_GATE_BUILD_ID, workerProtocolVersion: 2,
        capabilities: [
          'idempotent-admission-v1', 'durable-before-execute-v1', 'recovery-capsule-v1',
          'run-tree-token-budget-v1', 'crash-durable-token-reservations-v1', 'host-git-baseline-v1',
          'direct-child-authority-v1', 'strict-handoff-v1', 'blocking-supervisor-review-v1', 'bearer-auth-v1',
        ],
      }),
    ),
  })
  managers.push(manager)
  return manager
}

describe('reviewed supervision across risk, progress and lifecycle boundaries', () => {
  it('rejects new reviewed PTC work before model selection or dispatch, while delegated PTC remains available', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/fixture', agentPreset: 'code' })
    const manager = managerWith(api)
    for (const mode of [undefined, 'reviewed'] as const) {
      await expect(manager.task({ sessionId: 's1', objective: 'Check fixture', supervisionMode: mode })).rejects.toThrow(/requires agentPreset "standard"/)
    }
    expect(api.promptCalls).toBe(0)
    expect(api.modelSelections).toHaveLength(0)
    await expect(manager.task({ sessionId: 's1', objective: 'Check fixture', supervisionMode: 'delegated' })).resolves.toMatchObject({ supervisionMode: 'delegated', agentPreset: 'code' })
  })

  it('carries a blocking review through native question transport, immediate wait and exact-run answer without dispatching again', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/fixture', running: true, events: initial() })
    const manager = managerWith(api)
    const address = { sessionId: packet.sessionId, runId: packet.runId }
    const before = await manager.wait({ ...address, timeoutMs: 0 })
    let resolveAnswer!: (answer: { answers: Array<{ id: string; selected: string[] }> }) => void
    const respond = vi.spyOn(api.api, 'respond').mockImplementation(async envelope => {
      const response = envelope as unknown as { rpcId: string; result: { value: { answer: Parameters<typeof resolveAnswer>[0] } } }
      expect(response.rpcId).toBe('review-rpc')
      resolveAnswer(response.result.value.answer)
      return { accepted: true }
    })
    const awaitingReview = awaitSupervisorReview({ ask: async input => {
      api.pushMux({ rpcId: 'review-rpc', payload: {
        type: 'question/requested', sessionId: 's1', questions: input.questions,
      } } as never)
      return new Promise(resolve => { resolveAnswer = resolve })
    } }, { ...address, category: 'public_interface', proposal: 'API doneWhen[0]: preserve the old entry point.', rationale: 'src/api.ts: add validation internally, without changing the schema.' }, { agent: {}, signal: new AbortController().signal }, 'dsh-review:fixture')
    const observed = await manager.wait({ ...address, afterAsOfSeq: before.asOfSeq, timeoutMs: 300_000 })
    expect(observed).toMatchObject({
      status: 'QUESTION_REQUIRED', decision: { timing: 'immediate', action: 'RESOLVE_INTERACTION' },
      question: { rpcId: 'review-rpc', questions: [{ id: 'dsh-review:fixture', detail: expect.stringContaining('src/api.ts') }] },
    })
    expect(observed.question?.answerInWeb).toBeUndefined()
    const answers = [{ id: 'dsh-review:fixture', selected: ['Approve'] }]
    await expect(manager.answerQuestion({ ...address, runId: '33333333-3333-4333-8333-333333333333', rpcId: 'review-rpc', answers })).rejects.toThrow()
    await expect(manager.answerQuestion({ ...address, rpcId: 'stale-rpc', answers })).rejects.toThrow(/stale/)
    expect(respond).not.toHaveBeenCalled()
    await manager.answerQuestion({ ...address, rpcId: 'review-rpc', answers })
    expect(await awaitingReview).toMatchObject({ approved: true, ...address })
    expect(api.promptCalls).toBe(0)
    respond.mockRestore()
  })

  it('does not downgrade critical risk for a cadence or pre-authorized worker decision', () => {
    for (const authority of [undefined, { preAuthorizedDecisionCategories: ['information'] }]) {
      const observed = deriveObservation(state([
        ...initial({ authority }), ...progress(2, { ...risk, decision: {
          category: 'information', impact: 'low', blocking: false, request: 'Review naming later.',
        } }),
      ]))
      expect(observed).toMatchObject({
        status: 'SUPERVISOR_REQUIRED', decision: { timing: 'immediate', reasonCode: 'REPORTED_HIGH_RISK' },
      })
    }
  })

  it('retains human authority on an older risk after ordinary progress', () => {
    const observed = deriveObservation(state([
      ...initial(), ...progress(2, { ...risk, decision: {
        category: 'security', impact: 'high', blocking: true, request: 'Approve the security change.',
      } }),
      ...progress(4, { ...risk, riskLevel: 'low', milestone: 'Tests are running.' }),
    ]))
    expect(observed).toMatchObject({
      status: 'SUPERVISOR_REQUIRED', boundarySeq: 3,
      decision: { timing: 'immediate', audience: 'human', action: 'ASK_HUMAN' },
    })
  })

  it('retains unhandled risk and the latest ordinary milestone separately', () => {
    const observed = deriveObservation(state([
      ...initial(), ...progress(2), ...progress(4, { ...risk, riskLevel: 'low', milestone: 'Tests are running.' }),
    ]))
    expect(observed).toMatchObject({
      status: 'SUPERVISOR_REQUIRED', boundarySeq: 3,
      supervisorProgress: { milestone: 'Tests are running.' },
      pendingRisks: { total: 1, entries: [{ boundarySeq: 3, riskLevel: 'critical' }], truncated: false },
    })
    expect(() => observationSchema.parse(observed)).not.toThrow()
  })

  it('consumes earlier risk through durable guidance while retaining later risk', () => {
    const guided = [...initial(), ...progress(2), event('user/message', 4, {
      content: [{ type: 'text', text: 'Keep the existing public contract.' }],
    })]
    expect(deriveObservation(state(guided))).toMatchObject({ status: 'WAITING' })
    expect(deriveObservation(state(guided)).pendingRisks).toBeUndefined()
    expect(deriveObservation(state([...guided, ...progress(5)]))).toMatchObject({
      status: 'SUPERVISOR_REQUIRED', boundarySeq: 6, pendingRisks: { total: 1 },
    })
  })

  it('bounds risk previews without losing the durable pending count', () => {
    const observed = deriveObservation(state([
      ...initial(), ...Array.from({ length: 6 }, (_, index) => progress(2 + index * 2)).flat(),
    ]))
    expect(observed.pendingRisks).toMatchObject({ total: 6, truncated: true })
    expect(observed.pendingRisks?.entries).toHaveLength(4)
    expect(() => observationSchema.parse(observed)).not.toThrow()
  })

  it('preserves delegated cadence without adding reviewed risk boundaries', () => {
    const observed = deriveObservation(state([...initial({ supervisionMode: 'delegated' }), ...progress(2)]))
    expect(observed).toMatchObject({ status: 'WAITING', decision: { timing: 'cadence' } })
    expect(observed.pendingRisks).toBeUndefined()
  })

  it('keeps interruption, worker failure and missing handoff authoritative after risk', () => {
    for (const [kind, failure] of [['interrupted', 'HOST_FAILED'], ['error', 'WORKER_FAILED'], ['completed', 'MISSING_HANDOFF']]) {
      const observed = deriveObservation(state([...initial(), ...progress(2), end(4, kind)], { workerState: 'IDLE' }))
      expect(observed).toMatchObject({
        status: 'FAILED', failure: { kind: failure }, decision: { action: 'REVIEW_FAILURE' },
        pendingRisks: { total: 1 },
      })
      if (kind === 'interrupted') expect(observed.recovery?.kind).toBe('CONTINUATION_REQUIRED')
    }
  })

  it('reaches independent terminal review with unresolved risk attached', () => {
    for (const reports of [[], progress(2)]) {
      const observed = deriveObservation(state([...initial(), ...reports, ...handoff()], { workerState: 'IDLE' }))
      expect(observed).toMatchObject({ status: 'COMPLETED', decision: { action: 'REVIEW_TERMINAL' } })
      if (reports.length > 0) expect(observed.pendingRisks?.total).toBe(1)
    }
  })

  it('does not let a cadence decision hide approval, Host failure or budget stop timing', () => {
    const events = [...initial(), ...progress(2, { ...risk, riskLevel: 'low', decision: {
      category: 'information', impact: 'low', blocking: false, request: 'Review naming later.',
    } })]
    expect(deriveObservation(state(events, { hostError: 'Host failed' }))).toMatchObject({
      status: 'FAILED', decision: { timing: 'immediate', action: 'REVIEW_FAILURE' },
    })
    expect(deriveObservation(state(events, { pendingQuestion: { rpcId: 'q1', questions: [] } }))).toMatchObject({
      status: 'QUESTION_REQUIRED', decision: { timing: 'immediate', action: 'RESOLVE_INTERACTION' },
    })
    const stopped = deriveObservation(state([...initial(), ...progress(2), event('turn/end', 4, {
      turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'dsh-gate:token-budget-exhausted;used=10;limit=10' } },
    })], { workerState: 'IDLE' }))
    expect(stopped).toMatchObject({
      status: 'ESCALATION_REQUIRED', decision: { timing: 'immediate', action: 'REVIEW_FAILURE' },
      pendingRisks: { total: 1 },
    })
  })

  it('replacement MCP wait/recover/list preserve the interrupted recovery boundary', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/fixture', events: [...initial(), ...progress(2), end(4, 'interrupted')] })
    const manager = managerWith(api)
    const address = { sessionId: packet.sessionId, runId: packet.runId }
    expect(await manager.wait({ ...address, timeoutMs: 0 })).toMatchObject({
      status: 'FAILED', recovery: { kind: 'CONTINUATION_REQUIRED' }, pendingRisks: { total: 1 },
    })
    const recovered = await managerWith(api).recover(address)
    expect(recovered).toMatchObject({
      status: 'FAILED', recovery: { kind: 'CONTINUATION_REQUIRED' },
      recoveryCapsule: { parentRunId: packet.runId }, pendingRisks: { total: 1 },
    })
    expect(api.recoveryCapsuleCalls).toBeGreaterThan(0)
    expect(await manager.runs()).toMatchObject({ entries: [{ status: 'FAILED', stage: 'host-restart-interrupted' }] })
  })

  it('repeated wait cursors cannot erase an unhandled risk', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/fixture', running: true, events: [
      ...initial(), ...progress(2), ...progress(4, { ...risk, riskLevel: 'low' }),
    ] })
    const manager = managerWith(api)
    const address = { sessionId: packet.sessionId, runId: packet.runId, timeoutMs: 0 }
    const first = await manager.wait(address)
    expect(first).toMatchObject({ status: 'SUPERVISOR_REQUIRED', boundarySeq: 3 })
    expect(await manager.wait({ ...address, afterAsOfSeq: first.asOfSeq })).toMatchObject({
      status: 'SUPERVISOR_REQUIRED', boundarySeq: 3, pendingRisks: { total: 1 },
    })
  })
  const evidence = {
    criteria: [{ workstreamId: 'W1', doneWhenIndex: 0, status: 'unmet', evidence: 'Compatibility check has not passed.' }],
    planChanges: [], negativeEvidence: ['Compatibility remains unverified.'], evidencePaths: ['src/api.ts'],
    omitted: { criteria: 0, planChanges: 0, negativeEvidence: 0, evidencePaths: 0 },
  }
  const observedWithReview = (events: DshEvent[], from = 0) => {
    const runtime = state(events, { cwd: '/fixture' })
    return progressObservation(deriveObservation(runtime), runtime, from)
  }

  it('preserves bounded negative evidence as worker claims and flags summary omissions', () => {
    const observed = observedWithReview([...initial(), ...progress(2, { ...risk, reviewEvidence: evidence })])
    expect(observed.supervisorProgress?.reviewEvidence).toEqual(evidence)
    expect(observed.reviewSignals).toMatchObject({ summaryCoverage: 'PROVIDED', reasons: ['WORKER_MILESTONE'] })
    expect(observedWithReview([...initial(), ...progress(2, {
      ...risk, reviewEvidence: { ...evidence, omitted: { ...evidence.omitted, negativeEvidence: 2 } },
    })]).reviewSignals).toMatchObject({ summaryCoverage: 'INCOMPLETE' })
    expect(() => observationSchema.parse(observed)).not.toThrow()
  })

  it('does not discard critical risk when a legacy result carries malformed review evidence', () => {
    for (const reviewEvidence of [{}, { ...evidence, criteria: [{ ...evidence.criteria[0], workstreamId: 'UNKNOWN' }] }]) {
      const observed = observedWithReview([...initial(), ...progress(2, { ...risk, reviewEvidence })])
      expect(observed).toMatchObject({ status: 'SUPERVISOR_REQUIRED', pendingRisks: { total: 1 } })
      expect(observed.reviewSignals?.summaryCoverage).toBe('INVALID')
    }
    expect(observedWithReview([...initial(), ...progress(2)]).reviewSignals?.summaryCoverage).toBe('MISSING')
  })

  it('matches watched writes beyond the ordinary file preview without trusting evidencePaths', () => {
    const edits = Array.from({ length: 12 }, (_, index) => [
      event('tool/call', 2 + index * 2, { callId: `edit${index}`, name: 'write', arguments: JSON.stringify({
        file_path: index === 11 ? '/fixture/zz/api.ts' : `/fixture/a${index}.ts`, content: 'fixture',
      }) }), result(3 + index * 2, `edit${index}`, {}),
    ]).flat()
    const observed = observedWithReview([...initial({ reviewWatchPaths: ['zz'] }), ...edits])
    expect(observed.progress?.projectActivity.edits.files).not.toContain('zz/api.ts')
    expect(observed.reviewSignals).toMatchObject({ watchedFiles: ['zz/api.ts'] })
    expect(observed.reviewSignals?.reasons).toContain('WATCHED_PATH_CHANGED')
    const claimed = observedWithReview([...initial({ reviewWatchPaths: ['src/api.ts'] }), ...progress(2, { ...risk, reviewEvidence: evidence })])
    expect(claimed.reviewSignals?.watchedFiles).toEqual([])
    expect(claimed.reviewSignals?.reasons).not.toContain('WATCHED_PATH_CHANGED')
  })

  it('observes a watched mutation completed after the preceding cursor', () => {
    const events = [...initial({ reviewWatchPaths: ['src'] }),
      event('tool/call', 2, { callId: 'edit', name: 'write', arguments: JSON.stringify({ file_path: '/fixture/src/api.ts' }) }),
      result(3, 'edit', {}),
    ]
    expect(observedWithReview(events, 2).reviewSignals?.watchedFiles).toEqual(['src/api.ts'])
    expect(observedWithReview(events, 3).reviewSignals?.watchedFiles).toEqual([])
  })

  it('uses Host Git-baseline paths for shell changes and exposes incomplete activity coverage', () => {
    const observed = observedWithReview([
      ...initial({ reviewWatchPaths: ['src'] }),
      event('tool/call', 2, { callId: 'p2', name: 'supervisor_progress', arguments: JSON.stringify(risk) }),
      result(3, 'p2', { accepted: true, progress: risk, workspaceChanges: {
        source: 'HOST_GIT_BASELINE', total: 20, files: ['src/api.ts'], truncated: true,
      } }),
    ])
    expect(observed.reviewSignals).toMatchObject({ watchedFiles: ['src/api.ts'], activityCoverage: 'partial' })
    expect(observed.reviewSignals?.reasons).toContain('ACTIVITY_COVERAGE_GAP')
  })

  it('keeps Host-observed failed verification visible despite a positive worker summary', () => {
    const events = [
      ...initial(), event('tool/call', 2, { callId: 'test', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }),
      event('tool/result', 3, { message: { source: { callId: 'test' }, content: [{ type: 'tool-result', isError: true, content: [] }] } }),
      ...progress(4, { ...risk, riskLevel: 'low', milestone: 'Everything looks good.', reviewEvidence: { ...evidence, negativeEvidence: [] } }),
    ]
    const observed = observedWithReview(events)
    expect(observed.reviewSignals?.reasons).toContain('NEGATIVE_VERIFICATION')
    expect(observed.decision?.timing).toBe('cadence')
    expect(observedWithReview(events, 5).reviewSignals?.reasons).not.toContain('WORKER_MILESTONE')
  })

  it('pins review watch paths across idempotent dispatch and recovery', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/fixture' })
    const manager = managerWith(api)
    const input = { sessionId: 's1', objective: 'inspect API', writerMode: 'read_only' as const,
      supervisionMode: 'reviewed' as const, reviewWatchPaths: ['src/api.ts'],
      requestId: '33333333-3333-4333-8333-333333333333' }
    const receipt = await manager.task(input)
    expect(receipt.reviewWatchPaths).toEqual(['src/api.ts'])
    await expect(manager.task(input)).resolves.toMatchObject({ runId: receipt.runId, reconciled: true })
    await expect(manager.task({ ...input, reviewWatchPaths: ['different'] })).rejects.toThrow(/different task payload/)
    const events = api.rows.get('s1')!.events
    const seq = events.at(-1)!.seq
    api.setRunning('s1', false)
    api.setEvents('s1', [...events, event('turn/start', seq + 1, { turn: 1 }), end(seq + 2, 'interrupted')])
    const recovered = await manager.recover({ sessionId: 's1', runId: receipt.runId as string })
    const continuation = { sessionId: 's1', objective: 'continue', parentRunId: receipt.runId as string,
      recoveryCapsule: recovered.recoveryCapsule }
    await expect(manager.task({ ...continuation, reviewWatchPaths: ['different'] })).rejects.toThrow(/reviewWatchPaths must match/)
    await expect(manager.task(continuation)).resolves.toMatchObject({ reviewWatchPaths: ['src/api.ts'], supervisionMode: 'reviewed', terminalReviewContract: 'criteria-v1' })
  })

  it('fails closed on accepted completed results missing the pinned final table', () => {
    const reviewed = initial({ terminalReviewContract: 'criteria-v1', executionBrief: {
      schemaVersion: 1, source: 'CODEX_COMPILED',
      workstreams: [{ id: 'W1', outcome: 'Preserve API', delegation: 'root', doneWhen: ['API is compatible.'] }],
      integration: ['Verify the result.'],
    } })
    const events = [...reviewed, ...handoff()]
    expect(deriveObservation(state(events, { workerState: 'IDLE' }))).toMatchObject({
      status: 'FAILED', stage: 'terminal-review-evidence', failure: { kind: 'PROTOCOL_ERROR' },
    })
    const finalReview = { ...evidence, negativeEvidence: [], criteria: [{
      workstreamId: 'W1', doneWhenIndex: 0, status: 'met', evidence: 'See src/api.ts and compatibility tests.',
    }] }
    const accepted = events.find(entry => entry.seq === 7)!
    const data = accepted.data as { message: { content: Array<{ content: Array<{ text: string }> }> } }
    const output = JSON.parse(data.message.content[0]!.content[0]!.text)
    output.handoff.finalReview = finalReview
    data.message.content[0]!.content[0]!.text = JSON.stringify(output)
    const observed = deriveObservation(state(events, { workerState: 'IDLE' }))
    expect(observed).toMatchObject({
      status: 'COMPLETED', decision: { action: 'REVIEW_TERMINAL' }, finalReview,
      supervision: { terminalReviewContract: 'criteria-v1' },
    })
    expect(() => observationSchema.parse(observed)).not.toThrow()
    output.handoff.finalReview.criteria[0].doneWhenIndex = 9
    data.message.content[0]!.content[0]!.text = JSON.stringify(output)
    expect(deriveObservation(state(events))).toMatchObject({ status: 'FAILED', stage: 'terminal-review-evidence' })
  })

  it('pins the final contract for new reviewed runs but leaves delegated runs lightweight', async () => {
    for (const mode of ['reviewed', 'delegated'] as const) {
      const api = new FakeApi()
      api.addRow('s1', { cwd: '/fixture' })
      const manager = managerWith(api)
      const input = { sessionId: 's1', objective: 'inspect', writerMode: 'read_only' as const,
        supervisionMode: mode, requestId: '55555555-5555-4555-8555-555555555555' }
      const first = await manager.task(input)
      const retry = await manager.task(input)
      expect(first.terminalReviewContract).toBe(mode === 'reviewed' ? 'criteria-v1' : undefined)
      expect(retry.terminalReviewContract).toBe(first.terminalReviewContract)
      expect(api.promptCalls).toBe(1)
    }
  })

})
