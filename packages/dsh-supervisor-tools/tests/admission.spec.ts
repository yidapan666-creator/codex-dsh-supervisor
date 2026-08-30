import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { recoveryCapsuleSchema } from '../../mcp-server/src/contracts.js'
import {
  HostRecoveryCoordinator,
  RECOVERY_CAPSULE_PATH,
  registerRecoveryCapsuleRoute,
  registerTaskAdmissionRoute,
  TASK_ADMISSION_PATH,
  TaskAdmissionCoordinator,
  TaskAdmissionError,
  type TaskAdmissionRequest,
  type TaskAdmissionRuntime,
} from '../src/admission.js'

const requestId = '33333333-3333-4333-8333-333333333333'
const firstRunId = '11111111-1111-4111-8111-111111111111'
const secondRunId = '22222222-2222-4222-8222-222222222222'
const digest = 'a'.repeat(64)

function request(runId = firstRunId, requestDigest = digest): TaskAdmissionRequest {
  const packet = {
    schemaVersion: 2,
    sessionId: 's1',
    runId,
    completionToken: '44444444-4444-4444-8444-444444444444',
    requestId,
    requestDigest,
    objective: 'atomic work',
    writerMode: 'read_only',
  }
  return {
    schemaVersion: 1,
    sessionId: 's1',
    requestId,
    requestDigest,
    runId,
    prompt: `atomic work\n\n<dsh-supervised-task>\n${JSON.stringify(packet)}\n</dsh-supervised-task>`,
    modelSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
  }
}

function harness(options: { cold?: boolean; running?: boolean; seed?: ReturnType<typeof inboxEvent>[] } = {}): {
  coordinator: TaskAdmissionCoordinator
  events: ReturnType<typeof inboxEvent>[]
  pending: Array<{ id: string; content: unknown[] }>
  calls: { models: number; prompt: number; flush: number; rearm: number; selectModel: number }
  runtime: TaskAdmissionRuntime
} {
  const events = [...(options.seed ?? [])]
  const pending = events.flatMap(event => event.type === 'agent/inbox/spliced'
    ? ((event.data as { inserted?: Array<{ id: string; content: unknown[] }> }).inserted ?? [])
    : [])
  const calls = { models: 0, prompt: 0, flush: 0, rearm: 0, selectModel: 0 }
  const agent: {
    status: 'idle' | 'running'
    session: { header: { id: string }; events: typeof events; append(type: string, data: unknown): ReturnType<typeof inboxEvent> }
    inbox: {
      nextTurn: typeof pending
      nextStep: typeof pending
      remove(id: string): boolean
    }
    followup(message: { id?: string; content?: unknown }): void
  } = {
    status: options.running === true ? 'running' as const : 'idle' as const,
    session: {
      header: { id: 's1', cwd: '/worktree/recovered' },
      events,
      append(type, data) {
        const appended = { type, seq: (events.at(-1)?.seq ?? -1) + 1, time: Date.now(), data }
        events.push(appended)
        return appended
      },
    },
    inbox: {
      nextTurn: pending,
      nextStep: [],
      remove(id: string) {
        const index = pending.findIndex(message => message.id === id)
        if (index < 0) return false
        pending.splice(index, 1)
        events.push({
          type: 'agent/inbox/spliced', seq: (events.at(-1)?.seq ?? -1) + 1, time: Date.now(),
          data: { target: 'next-turn', start: index, removedCount: 1, inserted: [] },
        })
        return true
      },
    },
    followup(message: { id?: string; content?: unknown }) {
      calls.rearm++
      const admitted = message as { id: string; content: unknown[] }
      pending.push(admitted)
      events.push(inboxEvent((events.at(-1)?.seq ?? -1) + 1, admitted))
    },
  }
  const attached = options.cold === true ? [] : [agent]
  const runtime: TaskAdmissionRuntime = {
    agents: { list: () => attached },
    sessions: { flush: async () => { calls.flush++; return true } },
    sessionPersistence: persistenceFrom(() => [agent.session]),
    apiProxy: {
      sessions: {
        models: async () => {
          calls.models++
          if (!attached.includes(agent)) attached.push(agent)
          return { result: { ok: true as const, value: {} } }
        },
        selectModel: async () => {
          calls.selectModel++
          return { result: { ok: true as const, value: {} } }
        },
        prompt: async (input) => {
          calls.prompt++
          const message = {
            id: `message-${calls.prompt}`,
            content: input.payload.content,
          }
          pending.push(message)
          events.push(inboxEvent((events.at(-1)?.seq ?? -1) + 1, message))
          agent.status = 'running'
          return { result: { ok: true as const, value: { accepted: true as const } } }
        },
      },
    },
  }
  return { coordinator: new TaskAdmissionCoordinator(runtime), events, pending, calls, runtime }
}

function inboxEvent(seq: number, message = {
  id: 'message-seed',
  content: [{ type: 'text', text: request().prompt }],
}) {
  return {
    type: 'agent/inbox/spliced',
    seq,
    time: Date.now(),
    data: { target: 'next-turn', start: 0, inserted: [message] },
  }
}

function persistenceFrom(
  sessions: () => Array<{
    header: { id: string; cwd?: string; parentSession?: string; seedLength?: number; createdAt?: number }
    events: ReadonlyArray<{ type: string; seq: number; time?: number; data: unknown }>
  }>,
): TaskAdmissionRuntime['sessionPersistence'] {
  return {
    listSnapshots: async () => sessions().map(session => ({ header: session.header, revision: 'test' })),
    inspect: async (id) => {
      const session = sessions().find(candidate => candidate.header.id === id)
      if (session === undefined) throw new Error(`missing test session ${id}`)
      return { meta: session.header, events: session.events }
    },
  }
}

function continuationRequest(
  capsule: Awaited<ReturnType<HostRecoveryCoordinator['capsule']>>,
  options: { mutateCapsule?: boolean } = {},
): TaskAdmissionRequest {
  const nextRequestId = '88888888-8888-4888-8888-888888888888'
  const nextRunId = '99999999-9999-4999-8999-999999999999'
  const nextDigest = 'c'.repeat(64)
  const recoveryCapsule = options.mutateCapsule === true
    ? { ...capsule, objective: 'fabricated durable evidence' }
    : capsule
  if (options.mutateCapsule === true) {
    let byteLength = 0
    for (let attempt = 0; attempt < 4; attempt++) {
      const next = Buffer.byteLength(JSON.stringify({ ...recoveryCapsule, byteLength }), 'utf8')
      if (next === byteLength) break
      byteLength = next
    }
    recoveryCapsule.byteLength = byteLength
  }
  const packet = {
    schemaVersion: 2,
    sessionId: 's1',
    runId: nextRunId,
    completionToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    requestId: nextRequestId,
    requestDigest: nextDigest,
    objective: 'continue exactly',
    writerMode: 'read_only',
    parentRunId: firstRunId,
    recoveryCapsule,
  }
  return {
    schemaVersion: 1,
    sessionId: 's1',
    requestId: nextRequestId,
    requestDigest: nextDigest,
    runId: nextRunId,
    parentRunId: firstRunId,
    recoveryCapsule,
    prompt: `continue exactly\n\n<dsh-supervised-task>\n${JSON.stringify(packet)}\n</dsh-supervised-task>`,
    modelSelection: { provider: 'provider-b', model: 'model-b' },
  }
}

describe('Host task admission', () => {
  it('serializes concurrent callers and returns one stable durable run id', async () => {
    const test = harness()
    const [first, second] = await Promise.all([
      test.coordinator.admit(request(firstRunId)),
      test.coordinator.admit(request(secondRunId)),
    ])

    expect(first).toMatchObject({ runId: firstRunId, reconciled: false })
    expect(second).toMatchObject({ runId: firstRunId, reconciled: true })
    expect(test.calls).toMatchObject({ prompt: 1, flush: 1 })
    expect(test.calls.selectModel).toBe(1)
    expect(test.events).toHaveLength(3)
    expect(test.events[0]).toMatchObject({ type: 'sandbox/mode', data: { mode: 'read-only' } })
    expect(test.events[1]).toMatchObject({ type: 'approval/policy', data: { policy: 'never' } })
  })

  it('serializes writer admission across sessions in one Host worktree domain', async () => {
    const first = request()
    const secondRequestId = '55555555-5555-4555-8555-555555555555'
    const secondRun = '66666666-6666-4666-8666-666666666666'
    const secondPacket = {
      schemaVersion: 2, sessionId: 's2', runId: secondRun,
      completionToken: '77777777-7777-4777-8777-777777777777',
      requestId: secondRequestId, requestDigest: 'b'.repeat(64), objective: 'other writer', writerMode: 'writer',
    }
    const second: TaskAdmissionRequest = {
      schemaVersion: 1, sessionId: 's2', requestId: secondRequestId, requestDigest: 'b'.repeat(64), runId: secondRun,
      prompt: `other writer\n\n<dsh-supervised-task>\n${JSON.stringify(secondPacket)}\n</dsh-supervised-task>`,
      modelSelection: { provider: 'provider-b', model: 'model-b' },
    }
    first.prompt = first.prompt.replace('"writerMode":"read_only"', '"writerMode":"writer"')
    const agents = [
      { id: 's1', cwd: '/work/tree/a', request: first, events: [] as ReturnType<typeof inboxEvent>[], status: 'idle' as 'idle' | 'running' },
      { id: 's2', cwd: '/work/tree/b', request: second, events: [] as ReturnType<typeof inboxEvent>[], status: 'idle' as 'idle' | 'running' },
    ]
    let prompts = 0
    let selections = 0
    const runtime: TaskAdmissionRuntime = {
      agents: {
        list: () => agents.map(entry => ({
          status: entry.status,
          session: {
            header: { id: entry.id, cwd: entry.cwd }, events: entry.events,
            append(type: string, data: unknown) {
              const appended = { type, seq: (entry.events.at(-1)?.seq ?? -1) + 1, time: Date.now(), data }
              entry.events.push(appended)
              return appended
            },
          },
          inbox: { nextTurn: [], nextStep: [], remove: () => false },
          followup: () => undefined,
        })),
      },
      sessions: { flush: async () => true },
      sessionPersistence: persistenceFrom(() => agents.map(entry => ({
        header: { id: entry.id, cwd: entry.cwd }, events: entry.events,
      }))),
      apiProxy: {
        sessions: {
          selectModel: async () => { selections++; return { result: { ok: true as const, value: {} } } },
          prompt: async (input) => {
            prompts++
            const entry = agents.find(candidate => candidate.id === input.payload.sessionId)
            if (entry === undefined) throw new Error('missing test agent')
            entry.events.push(inboxEvent((entry.events.at(-1)?.seq ?? -1) + 1, {
              id: `message-${entry.id}`, content: input.payload.content,
            }))
            entry.status = 'running'
            return { result: { ok: true as const, value: { accepted: true as const } } }
          },
        },
      },
    }
    const coordinator = new TaskAdmissionCoordinator(runtime, async () => '/work/tree')

    const results = await Promise.allSettled([coordinator.admit(first), coordinator.admit(second)])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject<TaskAdmissionError>({ code: 'WRITER_CONFLICT' })
    expect(prompts).toBe(1)
    expect(selections).toBe(1)
    expect(agents.flatMap(entry => entry.events).filter(event => event.type === 'sandbox/mode'))
      .toHaveLength(1)
    expect(agents.flatMap(entry => entry.events).find(event => event.type === 'sandbox/mode'))
      .toMatchObject({ data: { mode: 'workspace-write' } })
    expect(agents.flatMap(entry => entry.events).some(event => event.type === 'approval/policy')).toBe(false)
  })

  it('keeps the root writer lease while an affiliated descendant is still running', async () => {
    const first = request()
    first.prompt = first.prompt.replace('"writerMode":"read_only"', '"writerMode":"writer"')
    const secondRequestId = '55555555-5555-4555-8555-555555555555'
    const secondRun = '66666666-6666-4666-8666-666666666666'
    const secondPacket = {
      schemaVersion: 2, sessionId: 's2', runId: secondRun,
      completionToken: '77777777-7777-4777-8777-777777777777',
      requestId: secondRequestId, requestDigest: 'b'.repeat(64), objective: 'second writer', writerMode: 'writer',
    }
    const second: TaskAdmissionRequest = {
      schemaVersion: 1, sessionId: 's2', requestId: secondRequestId, requestDigest: 'b'.repeat(64), runId: secondRun,
      prompt: `second writer\n\n<dsh-supervised-task>\n${JSON.stringify(secondPacket)}\n</dsh-supervised-task>`,
      modelSelection: { provider: 'provider-b', model: 'model-b' },
    }
    const rootEvents: Array<{ type: string; seq: number; data: unknown }> = []
    const agents = [
      { status: 'idle' as 'idle' | 'running', session: { header: { id: 's1', cwd: '/worktree/a' }, events: rootEvents } },
      { status: 'idle' as 'idle' | 'running', session: { header: { id: 'child', parentSession: 's1' }, events: [] as typeof rootEvents } },
      { status: 'idle' as 'idle' | 'running', session: { header: { id: 's2', cwd: '/worktree/b' }, events: [] as typeof rootEvents } },
    ]
    const runtime: TaskAdmissionRuntime = {
      agents: { list: () => agents.map(agent => ({
        ...agent,
        session: {
          ...agent.session,
          append(type: string, data: unknown) {
            const appended = { type, seq: (agent.session.events.at(-1)?.seq ?? -1) + 1, time: Date.now(), data }
            agent.session.events.push(appended)
            return appended
          },
        },
        inbox: { nextTurn: [], nextStep: [], remove: () => false },
        followup: () => undefined,
      })) },
      sessions: { flush: async () => true },
      sessionPersistence: persistenceFrom(() => agents.map(agent => agent.session)),
      apiProxy: { sessions: {
        selectModel: async () => ({ result: { ok: true as const, value: {} } }),
        prompt: async (input) => {
          rootEvents.push(inboxEvent(1, { id: 'root-task', content: input.payload.content }))
          return { result: { ok: true as const, value: { accepted: true as const } } }
        },
      } },
    }
    const coordinator = new TaskAdmissionCoordinator(runtime, async () => '/worktree')
    await coordinator.admit(first)
    rootEvents.push({ type: 'turn/end', seq: 2, data: { turn: 1 } })
    agents[1]!.status = 'running'

    await expect(coordinator.admit(second)).rejects.toMatchObject({ code: 'WRITER_CONFLICT' })
  })

  it('rejects a new read-only run on a root whose previous descendant is still active', async () => {
    const first = request()
    first.prompt = first.prompt.replace('"writerMode":"read_only"', '"writerMode":"writer"')
    const nextRequestId = '88888888-8888-4888-8888-888888888888'
    const nextRun = '99999999-9999-4999-8999-999999999999'
    const nextPacket = {
      schemaVersion: 2, sessionId: 's1', runId: nextRun,
      completionToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requestId: nextRequestId, requestDigest: 'c'.repeat(64), objective: 'overlapping read', writerMode: 'read_only',
    }
    const next: TaskAdmissionRequest = {
      schemaVersion: 1, sessionId: 's1', requestId: nextRequestId, requestDigest: 'c'.repeat(64), runId: nextRun,
      prompt: `overlapping read\n\n<dsh-supervised-task>\n${JSON.stringify(nextPacket)}\n</dsh-supervised-task>`,
      modelSelection: { provider: 'provider-b', model: 'model-b' },
    }
    const rootEvents: Array<{ type: string; seq: number; data: unknown }> = []
    const agents = [
      { status: 'idle' as 'idle' | 'running', session: { header: { id: 's1', cwd: '/worktree/a' }, events: rootEvents } },
      { status: 'idle' as 'idle' | 'running', session: { header: { id: 'child', parentSession: 's1' }, events: [] as typeof rootEvents } },
    ]
    let prompts = 0
    const runtime: TaskAdmissionRuntime = {
      agents: { list: () => agents.map(agent => ({
        ...agent,
        session: {
          ...agent.session,
          append(type: string, data: unknown) {
            const appended = { type, seq: (agent.session.events.at(-1)?.seq ?? -1) + 1, time: Date.now(), data }
            agent.session.events.push(appended)
            return appended
          },
        },
        inbox: { nextTurn: [], nextStep: [], remove: () => false },
        followup: () => undefined,
      })) },
      sessions: { flush: async () => true },
      sessionPersistence: persistenceFrom(() => agents.map(agent => agent.session)),
      apiProxy: { sessions: {
        selectModel: async () => ({ result: { ok: true as const, value: {} } }),
        prompt: async (input) => {
          prompts++
          rootEvents.push(inboxEvent(rootEvents.length + 1, { id: `root-task-${prompts}`, content: input.payload.content }))
          return { result: { ok: true as const, value: { accepted: true as const } } }
        },
      } },
    }
    const coordinator = new TaskAdmissionCoordinator(runtime, async () => '/worktree')
    await coordinator.admit(first)
    rootEvents.push({ type: 'turn/end', seq: rootEvents.length + 1, data: { turn: 1 } })
    agents[1]!.status = 'running'

    await expect(coordinator.admit(next)).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    expect(prompts).toBe(1)
  })

  it('rejects reuse of a durable request id with a different digest', async () => {
    const test = harness()
    await test.coordinator.admit(request())
    await expect(test.coordinator.admit(request(secondRunId, 'b'.repeat(64))))
      .rejects.toMatchObject<TaskAdmissionError>({ code: 'REQUEST_ID_CONFLICT' })
    expect(test.calls.prompt).toBe(1)
  })

  it('requires and atomically revalidates the exact Host recovery capsule', async () => {
    const test = harness({ seed: [inboxEvent(0)] })
    test.pending.splice(0)
    test.events.push(
      { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'interrupted' } } },
    )
    const recovery = new HostRecoveryCoordinator(test.runtime)
    const capsule = await recovery.capsule('s1', firstRunId)
    expect(recoveryCapsuleSchema.safeParse(capsule).success).toBe(true)
    let recoveryHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const disposeRecovery = registerRecoveryCapsuleRoute({
      register(route) { recoveryHandler = route.handler; return () => undefined },
    }, recovery)
    const recoveryReq = Readable.from([JSON.stringify({
      type: 'client-request', rpcId: 'recover-1', method: 'dsh-gate.recovery-capsule',
      payload: { schemaVersion: 1, sessionId: 's1', parentRunId: firstRunId },
    })]) as IncomingMessage
    recoveryReq.method = 'POST'
    let recoveryBody = ''
    const recoveryRes = {
      destroyed: false,
      writeHead() { return this },
      end(chunk?: string) { recoveryBody += chunk ?? ''; return this },
    } as unknown as ServerResponse
    await recoveryHandler?.(recoveryReq, recoveryRes)
    disposeRecovery()
    expect(RECOVERY_CAPSULE_PATH).toBe('/api/dsh-gate.recovery-capsule')
    expect(JSON.parse(recoveryBody)).toMatchObject({
      type: 'server-response', rpcId: 'recover-1',
      result: { ok: true, value: { parentRunId: firstRunId, runTree: { coverage: 'complete' } } },
    })
    const ordinaryPacket = {
      schemaVersion: 2, sessionId: 's1', runId: secondRunId,
      completionToken: '77777777-7777-4777-8777-777777777777',
      requestId: '55555555-5555-4555-8555-555555555555', requestDigest: 'b'.repeat(64),
      objective: 'skip recovery', writerMode: 'read_only',
    }
    const ordinary: TaskAdmissionRequest = {
      schemaVersion: 1, sessionId: 's1', runId: secondRunId,
      requestId: ordinaryPacket.requestId, requestDigest: ordinaryPacket.requestDigest,
      prompt: `skip recovery\n\n<dsh-supervised-task>\n${JSON.stringify(ordinaryPacket)}\n</dsh-supervised-task>`,
      modelSelection: { provider: 'provider-b', model: 'model-b' },
    }

    await expect(test.coordinator.admit(ordinary))
      .rejects.toMatchObject<TaskAdmissionError>({ code: 'BAD_REQUEST' })
    await expect(test.coordinator.admit(continuationRequest(capsule, { mutateCapsule: true })))
      .rejects.toMatchObject<TaskAdmissionError>({ code: 'BAD_REQUEST' })
    expect(test.calls.prompt).toBe(0)

    const receipt = await test.coordinator.admit(continuationRequest(capsule))
    expect(receipt).toMatchObject({ runId: '99999999-9999-4999-8999-999999999999', reconciled: false })
    expect(test.calls.prompt).toBe(1)
  })

  it('resumes a cold persisted Root before exact writer continuation admission', async () => {
    const test = harness({ cold: true, seed: [inboxEvent(0)] })
    test.pending.splice(0)
    test.events.push(
      { type: 'agent/inbox/spliced', seq: 1, time: Date.now(), data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
      { type: 'turn/start', seq: 2, time: Date.now(), data: { turn: 1 } },
      { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1, reason: { kind: 'interrupted' } } },
    )
    const capsule = await new HostRecoveryCoordinator(test.runtime).capsule('s1', firstRunId)
    const continuation = continuationRequest(capsule)
    continuation.prompt = continuation.prompt.replace('"writerMode":"read_only"', '"writerMode":"writer"')
    const coordinator = new TaskAdmissionCoordinator(test.runtime, async cwd => cwd)

    const receipt = await coordinator.admit(continuation)

    expect(receipt).toMatchObject({ runId: '99999999-9999-4999-8999-999999999999', reconciled: false })
    expect(test.calls).toMatchObject({ models: 1, prompt: 1, selectModel: 1 })
  })

  it('fails closed when the native cold-session resolver cannot resume the Root', async () => {
    const test = harness({ cold: true })
    test.runtime.apiProxy.sessions.models = async () => ({
      result: { ok: false as const, error: { code: 'internal', message: 'resume storage offline' } },
    })

    await expect(test.coordinator.admit(request()))
      .rejects.toMatchObject<TaskAdmissionError>({ code: 'DURABILITY_UNAVAILABLE' })
    expect(test.calls.prompt).toBe(0)
    expect(test.calls.selectModel).toBe(0)
  })

  it('blocks a writer owned by a cold persisted Root in the same worktree', async () => {
    const writer = request()
    writer.prompt = writer.prompt.replace('"writerMode":"read_only"', '"writerMode":"writer"')
    const targetEvents: Array<{ type: string; seq: number; time?: number; data: unknown }> = []
    const targetSession = {
      header: { id: 's1', cwd: '/worktree/target' },
      events: targetEvents,
      append(type: string, data: unknown) {
        const appended = { type, seq: (targetEvents.at(-1)?.seq ?? -1) + 1, time: Date.now(), data }
        targetEvents.push(appended)
        return appended
      },
    }
    const coldPacket = request()
    coldPacket.prompt = coldPacket.prompt.replace('"writerMode":"read_only"', '"writerMode":"writer"')
      .replaceAll('s1', 'cold-root')
    const coldEvents = [
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: coldPacket.prompt }] } },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
    ]
    const runtime: TaskAdmissionRuntime = {
      agents: { list: () => [{
        status: 'idle', session: targetSession,
        inbox: { nextTurn: [], nextStep: [], remove: () => false }, followup: () => undefined,
      }] },
      sessions: { flush: async () => true },
      sessionPersistence: {
        listSnapshots: async () => [
          { header: targetSession.header, revision: 'target' },
          { header: { id: 'cold-root', cwd: '/worktree/cold' }, revision: 'cold' },
        ],
        inspect: async (id) => id === 'cold-root'
          ? { meta: { id: 'cold-root', cwd: '/worktree/cold' }, events: coldEvents }
          : { meta: targetSession.header, events: targetEvents },
      },
      apiProxy: { sessions: {
        selectModel: async () => ({ result: { ok: true as const, value: {} } }),
        prompt: async () => ({ result: { ok: true as const, value: { accepted: true as const } } }),
      } },
    }
    const coordinator = new TaskAdmissionCoordinator(runtime, async () => '/same-worktree')
    await expect(coordinator.admit(writer))
      .rejects.toMatchObject<TaskAdmissionError>({ code: 'WRITER_CONFLICT' })
  })

  it('fails closed when durable session enumeration is unavailable', async () => {
    const test = harness()
    test.runtime.sessionPersistence.listSnapshots = async () => { throw new Error('storage offline') }
    await expect(test.coordinator.admit(request()))
      .rejects.toMatchObject<TaskAdmissionError>({ code: 'DURABILITY_UNAVAILABLE' })
    expect(test.calls.prompt).toBe(0)
  })

  it('rejects an embedded task packet addressed to another session', async () => {
    const test = harness()
    const mismatched = request()
    mismatched.prompt = mismatched.prompt.replace('"sessionId":"s1"', '"sessionId":"s2"')

    await expect(test.coordinator.admit(mismatched))
      .rejects.toMatchObject<TaskAdmissionError>({ code: 'BAD_REQUEST' })
    expect(test.calls.prompt).toBe(0)
  })

  it('does not queue a new supervised task into a busy session', async () => {
    const test = harness({ running: true })
    await expect(test.coordinator.admit(request()))
      .rejects.toMatchObject<TaskAdmissionError>({ code: 'SESSION_BUSY' })
    expect(test.calls.prompt).toBe(0)
  })

  it('recovers the original receipt from a durable inbox after Host restart', async () => {
    const test = harness({ seed: [inboxEvent(0)] })
    const receipt = await test.coordinator.admit(request(secondRunId))

    expect(receipt).toMatchObject({ runId: firstRunId, reconciled: true })
    expect(test.calls).toMatchObject({ prompt: 0, rearm: 1, flush: 1 })
    expect(test.pending).toHaveLength(1)
    expect(test.pending[0]?.id).toBe('message-seed')
  })

  it('serves the standard DSH request envelope over the Host HTTP boundary', async () => {
    const test = harness()
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const dispose = registerTaskAdmissionRoute({
      register(route) {
        handler = route.handler
        return () => undefined
      },
    }, test.coordinator)
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: requestId,
      method: 'dsh-gate.admit',
      payload: request(),
    })
    const req = Readable.from([body]) as IncomingMessage
    req.method = 'POST'
    let status = 0
    let responseBody = ''
    const res = {
      destroyed: false,
      writeHead(code: number) { status = code; return this },
      end(chunk?: string) { responseBody += chunk ?? ''; return this },
    } as unknown as ServerResponse

    await handler?.(req, res)
    dispose()

    expect(TASK_ADMISSION_PATH).toBe('/api/dsh-gate.admit')
    expect(status).toBe(200)
    expect(JSON.parse(responseBody)).toMatchObject({
      type: 'server-response',
      rpcId: requestId,
      result: { ok: true, value: { runId: firstRunId, reconciled: false } },
    })
    expect(test.calls).toMatchObject({ prompt: 1, flush: 1 })
  })
})
