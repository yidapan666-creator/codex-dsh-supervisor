import { describe, expect, it } from 'vitest'
import {
  installDirectChildAuthorityGuards,
  installTokenBudgetGuards,
  liveTokenBudgetState,
  tokenBudgetStateForRun,
} from '../src/index.js'

const runId = '11111111-1111-4111-8111-111111111111'
const oldRunId = '33333333-3333-4333-8333-333333333333'
const nestedRunId = '44444444-4444-4444-8444-444444444444'
const packetFor = (id: string, sessionId = 'root') => ({
  schemaVersion: 2,
  sessionId,
  runId: id,
  completionToken: '22222222-2222-4222-8222-222222222222',
  objective: 'bounded work',
  writerMode: 'writer',
  budget: { maxTokens: 150 },
})

const packetEvent = (seq: number, time: number, id = runId, sessionId = 'root') => ({
  type: 'user/message', seq, time, data: {
    content: [{ type: 'text', text: `<dsh-supervised-task>\n${JSON.stringify(packetFor(id, sessionId))}\n</dsh-supervised-task>` }],
  },
})

const childLimitedPacketEvent = (seq: number, time: number, maxDirectChildren: number) => ({
  type: 'user/message', seq, time, data: {
    content: [{
      type: 'text',
      text: `<dsh-supervised-task>\n${JSON.stringify({
        ...packetFor(runId), authority: { maxDirectChildren },
      })}\n</dsh-supervised-task>`,
    }],
  },
})

const userMessage = (seq: number, time: number, text = 'delegated work') => ({
  type: 'user/message', seq, time, data: { content: [{ type: 'text', text }] },
})

const usage = (seq: number, time: number, turn: number, step: number, inputTokens: number, outputTokens: number) => ({
  type: 'assistant/message', seq, time, data: { turn, step, usage: { inputTokens, outputTokens } },
})

describe('Host token budget fold', () => {
  it('exposes the durable run-tree projection without a model call', async () => {
    const root = {
      header: { id: 'root' },
      events: [packetEvent(0, 100), usage(1, 110, 1, 1, 60, 40)],
    }
    const child = {
      header: { id: 'child', createdAt: 120, parentSession: 'root' },
      events: [userMessage(0, 121), usage(1, 130, 1, 1, 30, 20)],
    }
    const result = await tokenBudgetStateForRun({
      sessions: { list: () => [root] },
      sessionPersistence: {
        listSnapshots: async () => [{ header: child.header, revision: 'child-r1' }],
        inspect: async () => ({ meta: child.header, events: child.events }),
      },
    } as never, { schemaVersion: 1, sessionId: 'root', runId })

    expect(result).toMatchObject({
      sessionId: 'root', runId, limitTokens: 150, usedTokens: 150,
      sessions: 2, coverage: 'run_tree', enforcement: 'DSH_HOST_RUNTIME',
    })
  })

  it('aggregates a fork child suffix without double-counting its inherited seed', () => {
    const root = {
      header: { id: 'root' },
      events: [packetEvent(0, 100), usage(1, 110, 1, 1, 60, 40)],
    }
    const child = {
      header: { id: 'child', createdAt: 120, parentSession: 'root', seedLength: 2 },
      events: [
        packetEvent(0, 100),
        usage(1, 110, 1, 1, 60, 40),
        { type: 'session/end-seed', seq: 2, time: 120, data: {} },
        userMessage(3, 121),
        usage(4, 130, 2, 1, 30, 20),
      ],
    }
    const unrelated = {
      header: { id: 'other' },
      events: [packetEvent(0, 100), usage(1, 110, 1, 1, 999, 999)],
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

  it('affiliates fresh spawn descendants from durable lineage and accepted work boundaries', () => {
    const root = {
      header: { id: 'root' },
      events: [packetEvent(0, 100), usage(1, 110, 1, 1, 20, 10)],
    }
    const child = {
      header: { id: 'child', createdAt: 120, parentSession: 'root' },
      events: [userMessage(0, 121), usage(1, 130, 1, 1, 30, 20)],
    }
    const grandchild = {
      header: { id: 'grandchild', createdAt: 140, parentSession: 'child' },
      events: [userMessage(0, 141), usage(1, 150, 1, 1, 25, 15)],
    }

    expect(liveTokenBudgetState([root, child, grandchild], 'root', runId, 120)).toMatchObject({
      usedTokens: 120,
      exhausted: true,
      sessions: 3,
    })
  })

  it('excludes an old child until it accepts new work inside the current run window', () => {
    const root = {
      header: { id: 'root' },
      events: [
        packetEvent(0, 10, oldRunId),
        usage(1, 20, 1, 1, 10, 10),
        packetEvent(2, 100),
        usage(3, 110, 2, 1, 15, 5),
      ],
    }
    const child = {
      header: { id: 'child', createdAt: 30, parentSession: 'root' },
      events: [userMessage(0, 31, 'old work'), usage(1, 40, 1, 1, 500, 500)],
    }

    expect(liveTokenBudgetState([root, child], 'root', runId, 100)).toMatchObject({
      usedTokens: 20,
      sessions: 1,
    })

    child.events.push(userMessage(2, 120, 'new work'), usage(3, 130, 2, 1, 30, 10))
    expect(liveTokenBudgetState([root, child], 'root', runId, 100)).toMatchObject({
      usedTokens: 60,
      sessions: 2,
    })
  })

  it('keeps a separately supervised nested root out of its ancestor budget', () => {
    const root = {
      header: { id: 'root' },
      events: [packetEvent(0, 100), usage(1, 110, 1, 1, 15, 5)],
    }
    const child = {
      header: { id: 'child', createdAt: 120, parentSession: 'root' },
      events: [
        packetEvent(0, 121, nestedRunId, 'child'),
        usage(1, 130, 1, 1, 30, 20),
      ],
    }

    expect(liveTokenBudgetState([root, child], 'root', runId, 100)).toMatchObject({
      usedTokens: 20,
      sessions: 1,
    })
    expect(liveTokenBudgetState([root, child], 'child', nestedRunId, 100)).toMatchObject({
      usedTokens: 50,
      sessions: 1,
    })
  })

  it('replaces a streaming usage sample with the finalized sample for the same step', () => {
    const root = {
      header: { id: 'root' },
      events: [
        packetEvent(0, 100),
        { type: 'assistant/chunk', seq: 1, time: 110, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } } } },
        usage(2, 120, 1, 1, 25, 15),
      ],
    }
    expect(liveTokenBudgetState([root], 'root', runId, 100)).toMatchObject({
      usedTokens: 40, exhausted: false, remainingTokens: 60,
    })
  })

  it('reconciles a persisted cold child before a post-restart root step', async () => {
    const root = {
      header: { id: 'root' },
      events: [packetEvent(0, 100), usage(1, 110, 1, 1, 60, 40)],
    }
    const child = {
      header: { id: 'child', createdAt: 120, parentSession: 'root' },
      events: [userMessage(0, 121), usage(1, 130, 1, 1, 30, 20)],
    }
    const cancellations: string[] = []
    const rootAgent = {
      session: root,
      cancel: ({ reason }: { reason: string }) => { cancellations.push(reason) },
    }
    let preStep: ((
      payload: { agent: typeof rootAgent },
      next: () => Promise<{ kind: 'enter'; messages: unknown[] }>,
    ) => Promise<{ kind: string; messages?: unknown[] }>) | undefined
    const ctx = {
      sessions: { list: () => [root] },
      agents: { list: () => [rootAgent] },
      on(name: string, listener: unknown) {
        if (name === 'agent/pre-step') preStep = listener as typeof preStep
      },
      sessionPersistence: {
        listSnapshots: async () => [{ header: child.header, revision: 'child-r1' }],
        inspect: async () => ({ meta: child.header, events: child.events }),
      },
    }
    installTokenBudgetGuards(ctx as never)
    const decision = await preStep?.({ agent: rootAgent }, async () => ({ kind: 'enter', messages: [] }))

    expect(decision).toEqual({ kind: 'reject' })
    expect(cancellations).toHaveLength(1)
    expect(cancellations[0]).toContain('dsh-gate:token-budget-exhausted')
    expect(cancellations[0]).toContain('used=150')
  })

  it('immediately cancels the whole live run tree when a child usage event exhausts the budget', () => {
    const root = {
      header: { id: 'root' },
      events: [packetEvent(0, 100), usage(1, 110, 1, 1, 60, 40)],
    }
    const childUsage = usage(1, 130, 1, 1, 30, 20)
    const child = {
      header: { id: 'child', createdAt: 120, parentSession: 'root' },
      events: [userMessage(0, 121), childUsage],
    }
    const cancelled = new Set<string>()
    const agents = [root, child].map(session => ({
      session,
      cancel: () => { cancelled.add(session.header.id) },
    }))
    let sessionEvent: ((session: typeof child, event: typeof childUsage) => void) | undefined
    const ctx = {
      sessions: { list: () => [root, child] },
      agents: { list: () => agents },
      on(name: string, listener: unknown) {
        if (name === 'session/event') sessionEvent = listener as typeof sessionEvent
      },
      sessionPersistence: {
        listSnapshots: async () => [],
        inspect: async () => { throw new Error('not used') },
      },
    }
    installTokenBudgetGuards(ctx as never)

    sessionEvent?.(child, childUsage)

    expect([...cancelled].sort()).toEqual(['child', 'root'])
  })

  it('reserves estimated input before a request and caps that request output', async () => {
    const root = {
      header: { id: 'root' },
      events: [packetEvent(0, 100)],
    }
    const cancellations: string[] = []
    const agent = {
      session: root,
      cancel: ({ reason }: { reason: string }) => { cancellations.push(reason) },
    }
    const assembly = {
      sections: [{ name: 'persona', text: 'bounded persona' }],
      contexts: [],
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
      variables: {},
    }
    let measuredHeader: unknown
    let assemble: ((
      value: typeof assembly,
      context: { agent: typeof agent },
      next: () => Promise<typeof assembly>,
    ) => Promise<typeof assembly>) | undefined
    let request: ((
      payload: { agent: typeof agent; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<{ provider: string; model: string }>,
    ) => Promise<{ provider: string; model: string; maxTokens?: number }>) | undefined
    const ctx = {
      sessions: { list: () => [root] },
      agents: { list: () => [agent] },
      tokenMeter: {
        measure: (_session: typeof root, header: unknown) => {
          measuredHeader = header
          return { totalTokens: 50 }
        },
      },
      on(name: string, listener: unknown) {
        if (name === 'system-prompt/assemble') assemble = listener as typeof assemble
        if (name === 'agent/request') request = listener as typeof request
      },
      sessionPersistence: {
        listSnapshots: async () => [],
        inspect: async () => { throw new Error('not used') },
      },
    }
    installTokenBudgetGuards(ctx as never, { maxReservedOutputTokensPerRequest: 80 })
    await assemble?.(assembly, { agent }, async () => assembly)
    const config = await request?.(
      { agent, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek', model: 'flash' }),
    )

    expect(config).toMatchObject({ provider: 'deepseek', model: 'flash', maxTokens: 80 })
    expect(measuredHeader).toMatchObject({
      config: { provider: 'deepseek', model: 'flash' },
      system: 'bounded persona',
      tools: assembly.tools,
    })
    expect(cancellations).toEqual([])
  })

  it('waits for an in-flight tree reservation instead of overselling or cancelling it', async () => {
    const root = {
      header: { id: 'root' },
      events: [packetEvent(0, 100)],
    }
    const child = {
      header: { id: 'child', createdAt: 110, parentSession: 'root' },
      events: [userMessage(0, 111)],
    }
    const cancelled = new Set<string>()
    const rootAgent = { session: root, cancel: () => { cancelled.add('root') } }
    const childAgent = { session: child, cancel: () => { cancelled.add('child') } }
    const assembly = { sections: [], contexts: [], tools: [], variables: {} }
    let assemble: ((
      value: typeof assembly,
      context: { agent: typeof rootAgent },
      next: () => Promise<typeof assembly>,
    ) => Promise<typeof assembly>) | undefined
    let request: ((
      payload: { agent: typeof rootAgent; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<{ provider: string; model: string; maxTokens: number }>,
    ) => Promise<{ provider: string; model: string; maxTokens: number }>) | undefined
    let sessionEvent: ((session: typeof root, event: ReturnType<typeof usage>) => void) | undefined
    const ctx = {
      sessions: { list: () => [root, child] },
      agents: { list: () => [rootAgent, childAgent] },
      tokenMeter: { measure: () => ({ totalTokens: 20 }) },
      on(name: string, listener: unknown) {
        if (name === 'system-prompt/assemble') assemble = listener as typeof assemble
        if (name === 'agent/request') request = listener as typeof request
        if (name === 'session/event') sessionEvent = listener as typeof sessionEvent
      },
      sessionPersistence: {
        listSnapshots: async () => [],
        inspect: async () => { throw new Error('not used') },
      },
    }
    installTokenBudgetGuards(ctx as never, { maxReservedOutputTokensPerRequest: 100 })
    await assemble?.(assembly, { agent: rootAgent }, async () => assembly)
    await assemble?.(assembly, { agent: childAgent }, async () => assembly)
    const signal = new AbortController().signal
    const first = await request?.(
      { agent: rootAgent, turn: 1, step: 1, signal },
      async () => ({ provider: 'deepseek', model: 'flash', maxTokens: 100 }),
    )
    const secondPromise = request?.(
      { agent: childAgent, turn: 1, step: 1, signal },
      async () => ({ provider: 'deepseek', model: 'flash', maxTokens: 100 }),
    )
    expect(first?.maxTokens).toBe(100)
    expect(await Promise.race([secondPromise?.then(() => 'settled'), Promise.resolve('waiting')])).toBe('waiting')

    const rootUsage = usage(1, 120, 1, 1, 30, 10)
    root.events.push(rootUsage)
    sessionEvent?.(root, rootUsage)

    await expect(secondPromise).resolves.toMatchObject({ maxTokens: 90 })
    expect(cancelled.size).toBe(0)
  })
})

describe('Host direct-child authority guard', () => {
  it('atomically counts durable children and concurrent start reservations', async () => {
    const root = {
      header: { id: 'root', createdAt: 90 },
      events: [childLimitedPacketEvent(0, 100, 2)],
    }
    const existingChild = { id: 'child-1', createdAt: 110, parentSession: 'root' }
    const snapshots = [{ header: existingChild, revision: 'child-1-r1' }]
    const agent = { session: root, cancel: () => {} }
    type Decision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }
    type Execution = { name: string; token: symbol; agent: typeof agent }
    let preExecute: ((execution: Execution, next: () => Promise<Decision>) => Promise<Decision>) | undefined
    let toolResult: ((execution: Execution, result: { isError: boolean }) => void) | undefined
    const ctx = {
      sessions: { list: () => [root] },
      agents: { list: () => [agent] },
      on(name: string, listener: unknown) {
        if (name === 'tools/pre-execute') preExecute = listener as typeof preExecute
        if (name === 'tools/result') toolResult = listener as typeof toolResult
      },
      sessionPersistence: {
        listSnapshots: async () => snapshots,
        inspect: async () => { throw new Error('not used') },
      },
    }
    installDirectChildAuthorityGuards(ctx as never)

    const first = { name: 'subagent', token: Symbol('first'), agent }
    const second = { name: 'subagent', token: Symbol('second'), agent }
    await expect(preExecute?.(first, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })
    await expect(preExecute?.(second, async () => ({ kind: 'allow' }))).resolves.toMatchObject({
      kind: 'deny',
      reason: expect.stringContaining('dsh-gate:direct-child-limit'),
    })

    toolResult?.(first, { isError: false })
    snapshots.push({
      header: { id: 'child-2', createdAt: 120, parentSession: 'root' },
      revision: 'child-2-r1',
    })
    const third = { name: 'subagent', token: Symbol('third'), agent }
    await expect(preExecute?.(third, async () => ({ kind: 'allow' }))).resolves.toMatchObject({
      kind: 'deny',
      reason: expect.stringContaining('used=2;limit=2'),
    })
  })

  it('does not consume a slot for a failed start or an unrelated tool', async () => {
    const root = {
      header: { id: 'root', createdAt: 90 },
      events: [childLimitedPacketEvent(0, 100, 1)],
    }
    const agent = { session: root, cancel: () => {} }
    type Decision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }
    type Execution = { name: string; token: symbol; agent: typeof agent }
    let preExecute: ((execution: Execution, next: () => Promise<Decision>) => Promise<Decision>) | undefined
    let toolResult: ((execution: Execution, result: { isError: boolean }) => void) | undefined
    const ctx = {
      sessions: { list: () => [root] },
      agents: { list: () => [agent] },
      on(name: string, listener: unknown) {
        if (name === 'tools/pre-execute') preExecute = listener as typeof preExecute
        if (name === 'tools/result') toolResult = listener as typeof toolResult
      },
      sessionPersistence: {
        listSnapshots: async () => [],
        inspect: async () => { throw new Error('not used') },
      },
    }
    installDirectChildAuthorityGuards(ctx as never)

    const failed = { name: 'subagent', token: Symbol('failed'), agent }
    await expect(preExecute?.(failed, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })
    toolResult?.(failed, { isError: true })
    await expect(preExecute?.(
      { name: 'subagent', token: Symbol('retry'), agent },
      async () => ({ kind: 'allow' }),
    )).resolves.toEqual({ kind: 'allow' })
    await expect(preExecute?.(
      { name: 'read', token: Symbol('read'), agent },
      async () => ({ kind: 'allow' }),
    )).resolves.toEqual({ kind: 'allow' })
  })
})
