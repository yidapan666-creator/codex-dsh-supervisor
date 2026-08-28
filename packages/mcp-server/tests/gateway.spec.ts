import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-client-connection/network-client'
import type { SessionSummary } from '@deepseek-ai/dsh-client-connection/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WAIT_TIMEOUT_MS, GatewayManager, attachChildObservations, resolveSessionCwd, resolveWriterDomain, writerLeaseHeld,
} from '../src/gateway.js'
import { parseTaskPacket } from '../src/fold.js'
import { HostConnection } from '../src/host.js'
import { TASK_PACKET_END, TASK_PACKET_START, type DshEvent } from '../src/contracts.js'
import { FakeApi } from './host.fake.js'
import type { RunJournal, RunRecord } from '@dsh-gate/run-journal'
import { decisionPolicyDigest, DEFAULT_DECISION_POLICY } from '@dsh-gate/decision-policy'

const live: HostConnection[] = []
afterEach(() => {
  for (const connection of live) connection.stopClient()
})

function connected(api: FakeApi, baseUrl = 'http://host'): HostConnection {
  const connection = new HostConnection(baseUrl, api.api, request => api.admitTask(request))
  live.push(connection)
  return connection
}

function managerWith(api: FakeApi, resolve: (cwd: string) => Promise<string>): GatewayManager {
  return new GatewayManager({ hostUrls: ['http://host'], runJournal: false }, {
    resolveWriterDomain: resolve,
    createConnection: baseUrl => connected(api),
  })
}

const sameDomain = async (_cwd: string): Promise<string> => '/work/tree'

const event = (type: string, seq: number, data: unknown): DshEvent => ({ type, seq, time: seq, data })
const packetEvent = (seq: number, writerMode: 'writer' | 'read_only' = 'writer'): DshEvent => event('user/message', seq, {
  content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify({
    schemaVersion: 1, taskId: 's2', completionToken: 'token', objective: 'ship it', writerMode,
  })}\n${TASK_PACKET_END}` }],
})

/** A fully completed writer session: valid handoff result followed by its turn end. */
function completedWriterEvents(): DshEvent[] {
  const args = {
    taskId: 's2', completionToken: 'token', status: 'completed', stage: 'done', summary: 'verified', files: [], verification: [],
  }
  return [
    packetEvent(1),
    event('turn/start', 2, { turn: 1 }),
    event('tool/call', 3, {
      turn: 1, step: 1, callId: 'c1', name: 'supervisor_handoff', arguments: JSON.stringify(args),
    }),
    event('tool/result', 4, {
      turn: 1, step: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({ accepted: true, artifacts: [] }) }] }] },
    }),
    event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
  ]
}

describe('child observability', () => {
  it('attaches existing session projections without changing child ownership fields', () => {
    const entries = [{ kind: 'child', id: 'child-1', mode: 'continuable', activity: 'inactive' }]
    const sessions = [{
      sessionId: 'child-1', updatedAt: 1, running: false, blank: false,
      projections: {
        asOfSeq: 42,
        values: {
          sessionStats: { turns: 2, steps: 7 },
          tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
        },
      },
    }] as unknown as SessionSummary[]

    expect(attachChildObservations(entries, sessions)).toEqual([{
      kind: 'child', id: 'child-1', mode: 'continuable', activity: 'inactive',
      observation: {
        workerState: 'IDLE',
        telemetry: {
          asOfSeq: 42,
          sessionStats: { turns: 2, steps: 7 },
          tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
        },
      },
    }])
  })

  it('leaves a catalog entry observable even when its session row is unavailable', () => {
    expect(attachChildObservations([{ id: 'cold-child', activity: 'inactive' }], []))
      .toEqual([{ id: 'cold-child', activity: 'inactive' }])
  })
})

describe('writer domain resolution', () => {
  it('treats subdirectories of one Git worktree as the same writer domain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gate-domain-'))
    await mkdir(join(root, '.git'))
    const subA = join(root, 'a')
    const subB = join(root, 'b')
    await mkdir(subA)
    await mkdir(subB)
    await expect(resolveWriterDomain(subA)).resolves.toBe(await realpath(root))
    await expect(resolveWriterDomain(subB)).resolves.toBe(await realpath(root))
  })

  it('recognizes a linked worktree .git file without invoking Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gate-domain-'))
    await writeFile(join(root, '.git'), 'gitdir: /tmp/example\n')
    const sub = join(root, 'sub')
    await mkdir(sub)
    await expect(resolveWriterDomain(sub)).resolves.toBe(await realpath(root))
  })

  it('falls back to the exact realpath for non-Git directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gate-domain-'))
    const sub = join(root, 'sub')
    await mkdir(sub)
    await expect(resolveWriterDomain(root)).resolves.toBe(await realpath(root))
    await expect(resolveWriterDomain(sub)).resolves.toBe(await realpath(sub))
  })
})

describe('session cwd validation', () => {
  it('requires an absolute existing directory and resolves symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gate-session-cwd-'))
    const project = join(root, 'project')
    const alias = join(root, 'alias')
    const file = join(root, 'file.txt')
    await mkdir(project)
    await symlink(project, alias, 'dir')
    await writeFile(file, 'not a directory')

    await expect(resolveSessionCwd('relative/project')).rejects.toThrow(/absolute path/)
    await expect(resolveSessionCwd(join(root, 'missing'))).rejects.toThrow(/does not exist/)
    await expect(resolveSessionCwd(file)).rejects.toThrow(/not a directory/)
    await expect(resolveSessionCwd(alias)).resolves.toBe(await realpath(project))
  })

  it('requires cwd for creation and sends its canonical path to the Host', async () => {
    let createdCwd: string | undefined
    const connection = {
      baseUrl: 'http://host',
      ensureConnected: async () => ({ protocolVersion: 1, hostInstanceId: 'host-1', version: '0.1.0-rc.8' }),
      api: {
        sessions: {
          create: async (input: { cwd: string }) => {
            createdCwd = input.cwd
            return { result: { ok: true, value: { sessionId: 's-new' } } }
          },
        },
      },
      refreshSession: async () => ({ cwd: '/canonical/project' }),
    } as unknown as HostConnection
    const manager = new GatewayManager({ hostUrls: ['http://host'], runJournal: false }, {
      createConnection: () => connection,
      resolveSessionCwd: async cwd => cwd === '/alias/project' ? '/canonical/project' : cwd,
    })

    await expect(manager.startOrConnect({})).rejects.toThrow(/cwd is required/)
    await expect(manager.startOrConnect({ cwd: '/alias/project' })).resolves.toMatchObject({
      sessionId: 's-new', cwd: '/canonical/project',
    })
    expect(createdCwd).toBe('/canonical/project')
  })

  it('rejects a reconnect request that names a different cwd', async () => {
    const connection = {
      baseUrl: 'http://host',
      ensureConnected: async () => ({ protocolVersion: 1, hostInstanceId: 'host-1', version: '0.1.0-rc.8' }),
      sessionExists: async () => true,
      refreshSession: async () => ({ cwd: '/existing/project' }),
    } as unknown as HostConnection
    const manager = new GatewayManager({ hostUrls: ['http://host'], runJournal: false }, {
      createConnection: () => connection,
      resolveSessionCwd: async cwd => cwd,
    })

    await expect(manager.startOrConnect({
      hostBaseUrl: 'http://host', sessionId: 's-existing', cwd: '/other/project',
    })).rejects.toThrow(/does not match requested cwd/)
  })
})

describe('writer admission', () => {
  it('rejects a second writer run in the same durable session while its current run owns the lease', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree', events: [packetEvent(1), event('turn/start', 2, { turn: 1 })] })
    const manager = managerWith(api, sameDomain)

    await expect(manager.task({ sessionId: 's1', objective: 'second writer run' }))
      .rejects.toThrow(/already has writer session s1/)
  })

  it('rejects a second writer session in the same worktree domain while the first is active', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    api.addRow('s2', { cwd: '/work/tree', events: [packetEvent(1), event('turn/start', 2, { turn: 1 })] })
    const manager = managerWith(api, sameDomain)
    await expect(manager.task({ taskId: 's1', objective: 'write' }))
      .rejects.toThrow(/already has writer session s2/)
  })

  it('fails closed when an existing session writer domain cannot be resolved safely', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/current' })
    api.addRow('s2', { cwd: '/work/restricted', events: [packetEvent(1)] })
    const manager = managerWith(api, async (cwd: string) => {
      if (cwd.endsWith('/restricted')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return cwd
    })
    await expect(manager.task({ taskId: 's1', objective: 'write' }))
      .rejects.toThrow(/permission denied/)
  })

  it('allows a new writer once the previous writer session completed its handoff', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    api.addRow('s2', { cwd: '/work/tree', events: completedWriterEvents() })
    const manager = managerWith(api, sameDomain)
    await expect(manager.task({ taskId: 's1', objective: 'write' }))
      .resolves.toMatchObject({ taskId: 's1', writerMode: 'writer', accepted: true })
  })

  it('releases the writer run lease at turn end regardless of terminal handoff status', async () => {
    const ended = [packetEvent(1), event('turn/start', 2, { turn: 1 }), event('turn/end', 3, {
      turn: 1, reason: { kind: 'interrupted' },
    })]
    expect(writerLeaseHeld(ended)).toBe(false)
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree', events: ended })
    const manager = managerWith(api, sameDomain)

    await expect(manager.task({ sessionId: 's1', objective: 'new writer run' }))
      .resolves.toMatchObject({ sessionId: 's1', accepted: true })
  })

  it('lets a read-only root coexist with an active writer in the same domain', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    api.addRow('s2', { cwd: '/work/tree', events: [packetEvent(1), event('turn/start', 2, { turn: 1 })] })
    const manager = managerWith(api, sameDomain)
    await expect(manager.task({ taskId: 's1', objective: 'w', writerMode: 'writer' }))
      .rejects.toThrow(/already has writer session/)
    await expect(manager.task({ taskId: 's1', objective: 'r', writerMode: 'read_only' }))
      .resolves.toMatchObject({ writerMode: 'read_only', accepted: true })
  })

  it('serializes concurrent writer admissions so exactly one wins per worktree domain', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    api.addRow('s2', { cwd: '/work/tree' })
    const manager = managerWith(api, sameDomain)
    const results = await Promise.allSettled([
      manager.task({ taskId: 's1', objective: 'write one' }),
      manager.task({ taskId: 's2', objective: 'write two' }),
    ])
    const rejected = results.filter(result => result.status === 'rejected')
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringMatching(/already has writer session/),
    })
  })

  it('allows concurrent writers in distinct worktree domains', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/a' })
    api.addRow('s2', { cwd: '/work/b' })
    const manager = managerWith(api, async (cwd: string) => cwd)
    const results = await Promise.allSettled([
      manager.task({ taskId: 's1', objective: 'write one' }),
      manager.task({ taskId: 's2', objective: 'write two' }),
    ])
    expect(results.every(result => result.status === 'fulfilled')).toBe(true)
  })
})

describe('Web-visible task identity', () => {
  it('puts the human objective before the durable packet so DSH Web shows a useful title', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const manager = managerWith(api, sameDomain)
    await manager.task({ taskId: 's1', objective: 'Improve progress observability', writerMode: 'read_only' })
    const queued = api.rows.get('s1')?.events.at(-1)
    const text = ((queued?.data as { content?: Array<{ text?: string }> } | undefined)?.content ?? [])
      .map(block => block.text ?? '').join('\n')
    expect(text.startsWith('Improve progress observability\n\n')).toBe(true)
    expect(text).toContain(TASK_PACKET_START)
  })

  it('creates a distinct supervised run id for every task queued in one durable session', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const manager = managerWith(api, sameDomain)

    const first = await manager.task({ sessionId: 's1', objective: 'first', writerMode: 'read_only' })
    const firstPacket = parseTaskPacket(api.rows.get('s1')?.events ?? [])
    const second = await manager.task({ sessionId: 's1', objective: 'second', writerMode: 'read_only' })
    const secondPacket = parseTaskPacket(api.rows.get('s1')?.events ?? [])

    expect(first).toMatchObject({ sessionId: 's1', runId: expect.any(String) })
    expect(second).toMatchObject({ sessionId: 's1', runId: expect.any(String) })
    expect(first.runId).not.toBe(second.runId)
    expect(firstPacket).toMatchObject({
      schemaVersion: 2, sessionId: 's1', runId: first.runId,
      decisionPolicy: {
        activeVersion: DEFAULT_DECISION_POLICY.version,
        activeDigest: decisionPolicyDigest(DEFAULT_DECISION_POLICY),
      },
    })
    expect(secondPacket).toMatchObject({ schemaVersion: 2, sessionId: 's1', runId: second.runId })
  })

  it('reconciles an ambiguous repeated dispatch by requestId without queueing twice', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const manager = managerWith(api, sameDomain)
    const requestId = '33333333-3333-4333-8333-333333333333'
    const input = {
      sessionId: 's1', requestId, objective: 'bounded read', writerMode: 'read_only' as const,
      tokenBudget: { maxTokens: 123_456 },
    }

    const first = await manager.task(input)
    const eventCount = api.rows.get('s1')?.events.length
    const second = await manager.task(input)

    expect(second).toMatchObject({
      requestId, runId: first.runId, accepted: true, reconciled: true,
      tokenBudget: { maxTokens: 123_456 },
    })
    expect(api.rows.get('s1')?.events).toHaveLength(eventCount ?? 0)
    expect(parseTaskPacket(api.rows.get('s1')?.events ?? [])).toMatchObject({
      schemaVersion: 2, requestId, runId: first.runId, budget: { maxTokens: 123_456 },
    })
  })

  it('serializes the same request across two MCP managers at the Host admission boundary', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const firstManager = managerWith(api, sameDomain)
    const secondManager = managerWith(api, sameDomain)
    const input = {
      sessionId: 's1',
      requestId: '33333333-3333-4333-8333-333333333333',
      objective: 'one durable dispatch',
      writerMode: 'read_only' as const,
    }

    const [first, second] = await Promise.all([firstManager.task(input), secondManager.task(input)])

    expect(first.runId).toBe(second.runId)
    expect([first.reconciled, second.reconciled].sort()).toEqual([false, true])
    expect(api.promptCalls).toBe(1)
  })

  it('reconciles after the Host committed admission but the MCP response was lost', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    api.failAfterAdmissionOnce = true
    const firstManager = managerWith(api, sameDomain)
    const input = {
      sessionId: 's1',
      requestId: '33333333-3333-4333-8333-333333333333',
      objective: 'survive an ambiguous response',
      writerMode: 'read_only' as const,
    }

    await expect(firstManager.task(input)).rejects.toThrow(/response loss/)
    firstManager.stopClients()
    const secondManager = managerWith(api, sameDomain)

    await expect(secondManager.task(input)).resolves.toMatchObject({
      accepted: true,
      reconciled: true,
      requestId: input.requestId,
    })
    expect(api.promptCalls).toBe(1)
  })

  it('rejects reuse of a requestId with a changed payload', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const manager = managerWith(api, sameDomain)
    const requestId = '33333333-3333-4333-8333-333333333333'
    await manager.task({ sessionId: 's1', requestId, objective: 'first', writerMode: 'read_only' })
    await expect(manager.task({ sessionId: 's1', requestId, objective: 'changed', writerMode: 'read_only' }))
      .rejects.toThrow(/different task payload/)
  })

  it('rediscovers and reattaches to a durable run after the MCP manager restarts', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const firstManager = managerWith(api, sameDomain)
    const run = await firstManager.task({
      sessionId: 's1',
      requestId: '33333333-3333-4333-8333-333333333333',
      objective: 'survive client restart',
      writerMode: 'read_only',
    })
    firstManager.stopClients()

    const secondManager = managerWith(api, sameDomain)
    await expect(secondManager.runs()).resolves.toMatchObject({
      authoritativeSource: 'DSH_HOST_SESSIONS',
      entries: [{ sessionId: 's1', runId: run.runId, status: 'WAITING' }],
    })
    await expect(secondManager.recover({ sessionId: 's1', runId: run.runId as string })).resolves.toMatchObject({
      sessionId: 's1', runId: run.runId, status: 'WAITING',
      recovery: { kind: 'REATTACHED' },
    })
  })

  it('does not claim REATTACHED when recover addresses a stale run', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const manager = managerWith(api, sameDomain)
    await manager.task({ sessionId: 's1', objective: 'current run', writerMode: 'read_only' })

    const observed = await manager.recover({
      sessionId: 's1', runId: '44444444-4444-4444-8444-444444444444',
    })
    expect(observed).toMatchObject({
      status: 'FAILED',
      stage: 'stale-run',
      failure: { kind: 'PROTOCOL_ERROR', stale: true },
    })
    expect(observed.recovery).toBeUndefined()
  })

  it('keeps the policy pinned by the run after a manager restart', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const firstManager = managerWith(api, sameDomain)
    const run = await firstManager.task({ sessionId: 's1', objective: 'pinned', writerMode: 'read_only' })
    firstManager.stopClients()
    const newer = { ...DEFAULT_DECISION_POLICY, version: '2026-09-01.v2' }
    const secondManager = new GatewayManager({
      hostUrls: ['http://host'], runJournal: false, decisionPolicy: newer,
      decisionPolicyCatalog: [DEFAULT_DECISION_POLICY, newer],
    }, { resolveWriterDomain: sameDomain, createConnection: baseUrl => connected(api, baseUrl) })

    expect(await secondManager.wait({ sessionId: 's1', runId: run.runId as string, timeoutMs: 0 }))
      .toMatchObject({ decision: { policyVersion: DEFAULT_DECISION_POLICY.version } })
  })

  it('fails closed when a run pins changed policy contents', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const manager = managerWith(api, sameDomain)
    const run = await manager.task({ sessionId: 's1', objective: 'pinned', writerMode: 'read_only' })
    const packet = parseTaskPacket(api.rows.get('s1')?.events ?? [])
    expect(packet?.schemaVersion).toBe(2)
    const forged = { ...packet, decisionPolicy: {
      ...(packet?.schemaVersion === 2 ? packet.decisionPolicy : {}), activeDigest: '0'.repeat(64),
    } }
    api.setEvents('s1', [event('user/message', 1, {
      content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(forged)}\n${TASK_PACKET_END}` }],
    })])

    await expect(manager.wait({ sessionId: 's1', runId: run.runId as string, timeoutMs: 0 }))
      .rejects.toThrow(/unavailable or changed/)
  })

  it('parses the generated packet when the human objective contains packet-marker prose', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const manager = managerWith(api, sameDomain)
    const objective = `Document why ${TASK_PACKET_START} is reserved protocol syntax`

    const result = await manager.task({ sessionId: 's1', objective, writerMode: 'read_only' })

    expect(parseTaskPacket(api.rows.get('s1')?.events ?? [])).toMatchObject({
      schemaVersion: 2,
      sessionId: 's1',
      runId: result.runId,
      objective,
    })
  })

  it('rejects a stale wait instead of observing a newer run in the same session', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const manager = managerWith(api, sameDomain)
    const first = await manager.task({ sessionId: 's1', objective: 'first', writerMode: 'read_only' })
    const second = await manager.task({ sessionId: 's1', objective: 'second', writerMode: 'read_only' })

    const observed = await manager.wait({
      sessionId: 's1', runId: first.runId as string, timeoutMs: 0,
    })

    expect(observed).toMatchObject({
      sessionId: 's1', runId: second.runId, status: 'FAILED',
      failure: { kind: 'PROTOCOL_ERROR', stale: true },
    })
  })

  it('rejects stale steering before it can append a message to the newer run', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const manager = managerWith(api, sameDomain)
    const first = await manager.task({ sessionId: 's1', objective: 'first', writerMode: 'read_only' })
    const second = await manager.task({ sessionId: 's1', objective: 'second', writerMode: 'read_only' })
    const before = api.rows.get('s1')?.events.length

    await expect(manager.steer({
      sessionId: 's1', runId: first.runId as string, message: 'late guidance',
    })).rejects.toThrow(/stale run/i)

    expect(second.runId).not.toBe(first.runId)
    expect(api.rows.get('s1')?.events).toHaveLength(before ?? 0)
  })

  it('rejects a stale cancel before it can cancel the newer run', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree' })
    const manager = managerWith(api, sameDomain)
    const first = await manager.task({ sessionId: 's1', objective: 'first', writerMode: 'read_only' })
    await manager.task({ sessionId: 's1', objective: 'second', writerMode: 'read_only' })

    await expect(manager.cancel({ sessionId: 's1', runId: first.runId as string }))
      .rejects.toThrow(/stale run/i)
  })
})

describe('multi-Host reconnect', () => {
  it('discovers an existing session on a non-default configured Host and binds later calls to it', async () => {
    const first = new FakeApi()
    const second = new FakeApi()
    second.addRow('s-existing', { cwd: '/work/tree' })
    const manager = new GatewayManager({ hostUrls: ['http://host-one', 'http://host-two'], runJournal: false }, {
      resolveWriterDomain: sameDomain,
      createConnection: baseUrl => connected(baseUrl === 'http://host-one' ? first : second, baseUrl),
    })

    const reconnected = await manager.startOrConnect({ sessionId: 's-existing' })
    expect(reconnected).toMatchObject({
      sessionId: 's-existing', hostBaseUrl: 'http://host-two', reconnected: true,
    })
    await manager.task({ sessionId: 's-existing', objective: 'read it', writerMode: 'read_only' })
    expect(first.rows.has('s-existing')).toBe(false)
    expect(second.rows.get('s-existing')?.events).toHaveLength(1)
  })

  it('restores a replayed pending interaction after the MCP manager restarts', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work/tree', events: [s1Packet(1), event('turn/start', 2, { turn: 1 })] })
    const firstManager = managerWith(api, sameDomain)
    await firstManager.startOrConnect({ sessionId: 's1' })
    api.pushMux({
      rpcId: 'approval-replayed',
      payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'terminal' },
    } as unknown as RpcRequest<MuxFrame>)
    await sleep(30)
    expect(await firstManager.wait({ sessionId: 's1', timeoutMs: 0 })).toMatchObject({
      status: 'APPROVAL_REQUIRED', approval: { rpcId: 'approval-replayed' },
    })
    firstManager.stopClients()

    // The Host's stable-rpc-id replay contract is represented by replaying the
    // same envelope to the newly connected MCP client.
    api.pushMux({
      rpcId: 'approval-replayed',
      payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'terminal' },
    } as unknown as RpcRequest<MuxFrame>)
    const secondManager = managerWith(api, sameDomain)
    await secondManager.startOrConnect({ sessionId: 's1' })
    await sleep(30)
    expect(await secondManager.wait({ sessionId: 's1', timeoutMs: 0 })).toMatchObject({
      status: 'APPROVAL_REQUIRED', approval: { rpcId: 'approval-replayed' },
    })
  })
})

describe('Host launch coalescing', () => {
  it('launches only once when concurrent start_or_connect calls find the Host offline', async () => {
    let launchRequested = false
    let initialProbeCalls = 0
    let launchCalls = 0
    let signalInitialProbes!: () => void
    let allowInitialProbesToFail!: () => void
    let signalLaunchStarted!: () => void
    let allowHostToBecomeReady!: () => void
    const initialProbes = new Promise<void>(resolve => { signalInitialProbes = resolve })
    const initialProbesMayFail = new Promise<void>(resolve => { allowInitialProbesToFail = resolve })
    const launchStarted = new Promise<void>(resolve => { signalLaunchStarted = resolve })
    const hostMayBecomeReady = new Promise<void>(resolve => { allowHostToBecomeReady = resolve })
    let nextSession = 0
    const connection = {
      baseUrl: 'http://host',
      ensureConnected: async () => {
        if (!launchRequested) {
          initialProbeCalls++
          if (initialProbeCalls === 2) signalInitialProbes()
          await initialProbesMayFail
          throw new Error('Host offline')
        }
        await hostMayBecomeReady
        return { protocolVersion: 1, hostInstanceId: 'host-1', version: '0.1.0-rc.8' }
      },
      api: {
        sessions: {
          create: async () => ({ result: { ok: true, value: { sessionId: `s-${++nextSession}` } } }),
        },
      },
      refreshSession: async () => ({ cwd: '/work/tree' }),
    } as unknown as HostConnection
    const manager = new GatewayManager({
      hostUrls: ['http://host'],
      launch: { argv: ['host-start'] },
      runJournal: false,
    }, {
      createConnection: () => connection,
      resolveSessionCwd: async cwd => cwd,
      launchHost: async () => {
        launchCalls++
        launchRequested = true
        signalLaunchStarted()
      },
    })

    const first = manager.startOrConnect({ cwd: '/work/tree' })
    const second = manager.startOrConnect({ cwd: '/work/tree' })
    await initialProbes
    allowInitialProbesToFail()
    await launchStarted
    await sleep(5)
    expect(launchCalls).toBe(1)
    allowHostToBecomeReady()

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ sessionId: 's-1', hostInstanceId: 'host-1' }),
      expect.objectContaining({ sessionId: 's-2', hostInstanceId: 'host-1' }),
    ])
    expect(launchCalls).toBe(1)
  })
})

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const s1Packet = (seq: number): DshEvent => event('user/message', seq, {
  content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify({
    schemaVersion: 1, taskId: 's1', completionToken: 'token', objective: 'ship it', writerMode: 'writer',
  })}\n${TASK_PACKET_END}` }],
})
const toolCall = (seq: number, callId: string, name: string, args: object): DshEvent =>
  event('tool/call', seq, { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
const toolResult = (seq: number, callId: string): DshEvent =>
  event('tool/result', seq, {
    turn: 1, step: 1,
    message: { source: { callId }, content: [{ type: 'tool-result', isError: false, content: [] }] },
  })

/** A fully completed session whose packet names 's1': valid handoff + turn end. */
function s1CompletedEvents(): DshEvent[] {
  const args = {
    taskId: 's1', completionToken: 'token', status: 'completed', stage: 'done', summary: 'verified', files: [], verification: [],
  }
  return [
    s1Packet(1),
    event('turn/start', 2, { turn: 1 }),
    toolCall(3, 'c1', 'supervisor_handoff', args),
    event('tool/result', 4, {
      turn: 1, step: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({ accepted: true, artifacts: [] }) }] }] },
    }),
    event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
  ]
}

const v2RunId = '11111111-1111-4111-8111-111111111111'
const v2CompletionToken = '22222222-2222-4222-8222-222222222222'

function s1V2CompletedEvents(): DshEvent[] {
  const packet = {
    schemaVersion: 2,
    sessionId: 's1',
    runId: v2RunId,
    completionToken: v2CompletionToken,
    objective: 'ship with children',
    writerMode: 'writer',
    budget: { maxTokens: 100 },
  }
  const handoff = {
    sessionId: 's1',
    runId: v2RunId,
    completionToken: v2CompletionToken,
    status: 'completed',
    stage: 'done',
    summary: 'root verified',
    files: [],
    verification: [],
  }
  return [
    event('user/message', 1, {
      content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify(packet)}\n${TASK_PACKET_END}` }],
    }),
    event('turn/start', 2, { turn: 1 }),
    toolCall(3, 'v2-handoff', 'supervisor_handoff', handoff),
    event('tool/result', 4, {
      turn: 1,
      step: 1,
      message: { source: { callId: 'v2-handoff' }, content: [{
        type: 'tool-result',
        content: [{ type: 'text', text: JSON.stringify({ accepted: true, handoff, artifacts: [] }) }],
      }] },
    }),
    event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
  ]
}

describe('wait cadence', () => {
  it('defaults the wait window to the five-minute aggregated cadence', () => {
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(300_000)
  })

  it('does not return early on ordinary progress; it aggregates at the window boundary', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: [s1Packet(1)] })
    const manager = managerWith(api, sameDomain)
    const started = Date.now()
    const pending = manager.wait({ taskId: 's1', timeoutMs: 150 })
    await sleep(30)
    // Ordinary event churn arrives while waiting: a running turn, a successful
    // edit, and a completed step. The old behavior returned immediately with
    // WAITING/PROGRESS; the cadence must wait out the window instead.
    api.setEvents('s1', [
      s1Packet(1),
      event('turn/start', 2, { turn: 1 }),
      toolCall(3, 'e1', 'edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }),
      toolResult(4, 'e1'),
      event('step/end', 5, { turn: 1, step: 1 }),
    ])
    const observed = await pending
    expect(Date.now() - started).toBeGreaterThanOrEqual(120)
    expect(observed.status).toBe('WAITING')
    expect(observed.workerState).toBe('IDLE')
    expect(observed.wait).toEqual({ reason: 'TIMEOUT', timeoutMs: 150 })
    expect(observed.progress?.projectActivity).toEqual({
      coverage: 'complete',
      edits: { total: 1, files: ['src/a.ts'] },
      verification: { total: 0, commands: [], evidence: [] },
    })
    expect(observed.progress?.steps).toEqual({ completed: 1, delta: 1 })
    // Initial + final authoritative refresh are required. A cache-change wakeup
    // exactly at the deadline may add one final reconciliation; this remains
    // bounded and is not one HTTP history call per event.
    expect(api.historyCalls).toBeGreaterThanOrEqual(2)
    expect(api.historyCalls).toBeLessThanOrEqual(3)
  })

  it('folds mux event churn from cache without refreshing HTTP history for every event', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: [s1Packet(1)] })
    const manager = managerWith(api, sameDomain)
    const pending = manager.wait({ taskId: 's1', timeoutMs: 180 })
    await sleep(30)
    for (const pushed of [
      event('turn/start', 2, { turn: 1 }),
      toolCall(3, 'r1', 'read', { file_path: 'src/a.ts' }),
      toolResult(4, 'r1'),
      event('step/end', 5, { turn: 1, step: 1 }),
    ]) {
      api.pushMux({
        rpcId: `mux-${pushed.seq}`,
        payload: { type: 'session/event', sessionId: 's1', event: pushed },
      } as unknown as RpcRequest<MuxFrame>)
      await sleep(15)
    }

    const observed = await pending
    expect(observed).toMatchObject({
      status: 'WAITING',
      progress: { steps: { completed: 1, delta: 1 }, tools: { totalCalls: 1, deltaCalls: 1 } },
    })
    // One initial history fetch and one cadence-boundary reconciliation, not
    // one fetch per mux event.
    expect(api.historyCalls).toBe(2)
  })

  it('returns immediately for a terminal completed state', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: s1CompletedEvents() })
    const manager = managerWith(api, sameDomain)
    const started = Date.now()
    const observed = await manager.wait({ taskId: 's1', timeoutMs: 5_000 })
    expect(Date.now() - started).toBeLessThan(500)
    expect(observed.status).toBe('COMPLETED')
    expect(observed.projectActivity).toMatchObject({ toolCalls: 1, steps: 0 })
  })

  it('keeps a valid root handoff waiting until its affiliated child settles', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: s1V2CompletedEvents() })
    api.addChild('s1', 'child-1', {
      running: true,
      events: [
        { ...event('user/message', 0, { content: [{ type: 'text', text: 'delegated work' }] }), time: 10 },
        { ...event('turn/start', 1, { turn: 1 }), time: 11 },
      ],
    })
    const manager = managerWith(api, sameDomain)

    await expect(manager.wait({ sessionId: 's1', runId: v2RunId, timeoutMs: 0 })).resolves.toMatchObject({
      status: 'WAITING',
      stage: 'children-running',
      wait: { reason: 'TIMEOUT' },
    })

    api.setRunning('child-1', false)
    api.setEvents('child-1', [
      { ...event('user/message', 0, { content: [{ type: 'text', text: 'delegated work' }] }), time: 10 },
      { ...event('turn/start', 1, { turn: 1 }), time: 11 },
      { ...event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }), time: 12 },
    ])
    await expect(manager.wait({ sessionId: 's1', runId: v2RunId, timeoutMs: 0 })).resolves.toMatchObject({
      status: 'COMPLETED',
      summary: 'root verified',
    })
  })

  it('lets a durable child budget stop override an earlier completed root handoff', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: s1V2CompletedEvents() })
    api.addChild('s1', 'child-1', {
      events: [
        { ...event('user/message', 0, { content: [{ type: 'text', text: 'delegated work' }] }), time: 10 },
        { ...event('turn/start', 1, { turn: 1 }), time: 11 },
        { ...event('turn/end', 2, {
          turn: 1,
          reason: {
            kind: 'aborted',
            reason: { kind: 'hook', reason: `dsh-gate:token-budget-exhausted;runId=${v2RunId};used=150;limit=100` },
          },
        }), time: 12 },
      ],
    })
    const manager = managerWith(api, sameDomain)

    await expect(manager.wait({ sessionId: 's1', runId: v2RunId, timeoutMs: 0 })).resolves.toMatchObject({
      status: 'ESCALATION_REQUIRED',
      stage: 'token-budget-exhausted',
      budget: { observedTokens: 150, limitTokens: 100, exhausted: true, coverage: 'run_tree' },
    })
  })

  it('does not journal COMPLETED before an affiliated child converges', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: s1V2CompletedEvents() })
    const childPrompt = { ...event('user/message', 0, { content: [{ type: 'text', text: 'delegated work' }] }), time: 10 }
    api.addChild('s1', 'child-1', { running: true, events: [childPrompt] })
    const records: RunRecord[] = []
    const journal: RunJournal = {
      async record(value) { records.push(value); return { recordId: value.recordId, created: true } },
      async get() { return undefined },
      async list() { return records },
    }
    const manager = new GatewayManager({ hostUrls: ['http://host'], runJournal: journal }, {
      resolveWriterDomain: sameDomain, createConnection: baseUrl => connected(api, baseUrl),
    })

    expect((await manager.wait({ sessionId: 's1', runId: v2RunId, timeoutMs: 0 })).status).toBe('WAITING')
    expect(records).toHaveLength(0)

    api.setRunning('child-1', false)
    api.setEvents('child-1', [
      childPrompt,
      { ...event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }), time: 12 },
    ])
    expect((await manager.wait({ sessionId: 's1', runId: v2RunId, timeoutMs: 0 })).status).toBe('COMPLETED')
    expect(records).toHaveLength(1)
    expect(records[0]?.outcome).toBe('COMPLETED')
  })

  it('records a terminal run once from runtime facts without another model call', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: s1CompletedEvents() })
    const records: RunRecord[] = []
    const journal: RunJournal = {
      async record(value) {
        const created = records.length === 0
        if (created) records.push(value)
        return { recordId: value.recordId, created }
      },
      async get(runId) { return records.find(record => record.runId === runId) },
      async list() { return records },
    }
    const manager = new GatewayManager({ hostUrls: ['http://host'], runJournal: journal }, {
      resolveWriterDomain: sameDomain, createConnection: baseUrl => connected(api, baseUrl),
    })
    const first = await manager.wait({ taskId: 's1', timeoutMs: 0 })
    const second = await manager.wait({ taskId: 's1', timeoutMs: 0 })

    expect(first.journal).toMatchObject({ recorded: true, created: true })
    expect(second.journal).toMatchObject({ recorded: true, created: false })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      outcome: 'COMPLETED', summary: 'verified',
      provenance: { completionProtocolVerified: true, modelCallsUsed: 0 },
    })
  })

  it('preserves the terminal outcome when journal persistence fails', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: s1CompletedEvents() })
    const journal: RunJournal = {
      async record() { throw new Error('disk unavailable') },
      async get() { return undefined },
      async list() { return [] },
    }
    const manager = new GatewayManager({ hostUrls: ['http://host'], runJournal: journal }, {
      resolveWriterDomain: sameDomain, createConnection: baseUrl => connected(api, baseUrl),
    })
    expect(await manager.wait({ taskId: 's1', timeoutMs: 0 })).toMatchObject({
      status: 'COMPLETED',
      journal: { recorded: false, warning: 'run journal write failed (Error)' },
    })
  })

  it('returns immediately for a pending approval', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: [s1Packet(1), event('turn/start', 2, { turn: 1 })] })
    const manager = managerWith(api, sameDomain)
    api.pushMux({ rpcId: 'r1', payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'terminal' } } as unknown as RpcRequest<MuxFrame>)
    await sleep(30)
    const started = Date.now()
    const observed = await manager.wait({ taskId: 's1', timeoutMs: 5_000 })
    expect(Date.now() - started).toBeLessThan(500)
    expect(observed.status).toBe('APPROVAL_REQUIRED')
  })
})
