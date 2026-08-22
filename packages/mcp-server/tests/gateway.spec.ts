import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-client-connection/network-client'
import type { SessionSummary } from '@deepseek-ai/dsh-client-connection/client'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_WAIT_TIMEOUT_MS, GatewayManager, attachChildObservations, resolveWriterDomain } from '../src/gateway.js'
import { HostConnection } from '../src/host.js'
import { TASK_PACKET_END, TASK_PACKET_START, type DshEvent } from '../src/contracts.js'
import { FakeApi } from './host.fake.js'

const live: HostConnection[] = []
afterEach(() => {
  for (const connection of live) connection.stopClient()
})

function connected(api: FakeApi): HostConnection {
  const connection = new HostConnection('http://host', api.api)
  live.push(connection)
  return connection
}

function managerWith(api: FakeApi, resolve: (cwd: string) => Promise<string>): GatewayManager {
  return new GatewayManager({ hostUrls: ['http://host'] }, {
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

describe('writer admission', () => {
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
      edits: { total: 1, files: ['src/a.ts'] },
      verification: { total: 0, commands: [] },
    })
    expect(observed.progress?.steps).toEqual({ completed: 1, delta: 1 })
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
