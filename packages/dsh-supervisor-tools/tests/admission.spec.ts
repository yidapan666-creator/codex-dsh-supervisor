import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
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

function harness(options: { running?: boolean; seed?: ReturnType<typeof inboxEvent>[] } = {}): {
  coordinator: TaskAdmissionCoordinator
  events: ReturnType<typeof inboxEvent>[]
  pending: Array<{ id: string; content: unknown[] }>
  calls: { prompt: number; flush: number; rearm: number; selectModel: number }
} {
  const events = [...(options.seed ?? [])]
  const pending = events.flatMap(event => event.type === 'agent/inbox/spliced'
    ? ((event.data as { inserted?: Array<{ id: string; content: unknown[] }> }).inserted ?? [])
    : [])
  const calls = { prompt: 0, flush: 0, rearm: 0, selectModel: 0 }
  const agent: {
    status: 'idle' | 'running'
    session: { header: { id: string }; events: typeof events }
    inbox: {
      nextTurn: typeof pending
      nextStep: typeof pending
      remove(id: string): boolean
    }
    followup(message: { id?: string; content?: unknown }): void
  } = {
    status: options.running === true ? 'running' as const : 'idle' as const,
    session: { header: { id: 's1' }, events },
    inbox: {
      nextTurn: pending,
      nextStep: [],
      remove(id: string) {
        const index = pending.findIndex(message => message.id === id)
        if (index < 0) return false
        pending.splice(index, 1)
        events.push({
          type: 'agent/inbox/spliced', seq: events.length, data: { target: 'next-turn', start: index, removedCount: 1 },
        })
        return true
      },
    },
    followup(message: { id?: string; content?: unknown }) {
      calls.rearm++
      const admitted = message as { id: string; content: unknown[] }
      pending.push(admitted)
      events.push(inboxEvent(events.length, admitted))
    },
  }
  const runtime: TaskAdmissionRuntime = {
    agents: { list: () => [agent] },
    sessions: { flush: async () => { calls.flush++; return true } },
    apiProxy: {
      sessions: {
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
          events.push(inboxEvent(events.length, message))
          agent.status = 'running'
          return { result: { ok: true as const, value: { accepted: true as const } } }
        },
      },
    },
  }
  return { coordinator: new TaskAdmissionCoordinator(runtime), events, pending, calls }
}

function inboxEvent(seq: number, message = {
  id: 'message-seed',
  content: [{ type: 'text', text: request().prompt }],
}) {
  return {
    type: 'agent/inbox/spliced',
    seq,
    data: { target: 'next-turn', start: 0, inserted: [message] },
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
    expect(test.events).toHaveLength(1)
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
          session: { header: { id: entry.id, cwd: entry.cwd }, events: entry.events },
          inbox: { nextTurn: [], nextStep: [], remove: () => false },
          followup: () => undefined,
        })),
      },
      sessions: { flush: async () => true },
      apiProxy: {
        sessions: {
          selectModel: async () => { selections++; return { result: { ok: true as const, value: {} } } },
          prompt: async (input) => {
            prompts++
            const entry = agents.find(candidate => candidate.id === input.payload.sessionId)
            if (entry === undefined) throw new Error('missing test agent')
            entry.events.push(inboxEvent(entry.events.length, {
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
      { status: 'running' as 'idle' | 'running', session: { header: { id: 'child', parentSession: 's1' }, events: [] } },
      { status: 'idle' as 'idle' | 'running', session: { header: { id: 's2', cwd: '/worktree/b' }, events: [] } },
    ]
    const runtime: TaskAdmissionRuntime = {
      agents: { list: () => agents.map(agent => ({
        ...agent,
        inbox: { nextTurn: [], nextStep: [], remove: () => false },
        followup: () => undefined,
      })) },
      sessions: { flush: async () => true },
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

    await expect(coordinator.admit(second)).rejects.toMatchObject({ code: 'WRITER_CONFLICT' })
  })

  it('rejects reuse of a durable request id with a different digest', async () => {
    const test = harness()
    await test.coordinator.admit(request())
    await expect(test.coordinator.admit(request(secondRunId, 'b'.repeat(64))))
      .rejects.toMatchObject<TaskAdmissionError>({ code: 'REQUEST_ID_CONFLICT' })
    expect(test.calls.prompt).toBe(1)
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
