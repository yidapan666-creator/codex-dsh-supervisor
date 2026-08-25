import { afterEach, describe, expect, it } from 'vitest'
import { deriveObservation } from '../src/fold.js'
import { HostConnection, needsOlderHistoryPage } from '../src/host.js'
import { TASK_PACKET_END, TASK_PACKET_START, type DshEvent } from '../src/contracts.js'
import { FakeApi, settleFrames } from './host.fake.js'

const live: HostConnection[] = []
afterEach(() => {
  for (const connection of live) connection.stopClient()
})

function connected(api: FakeApi): HostConnection {
  const connection = new HostConnection('http://host', api.api)
  live.push(connection)
  return connection
}

describe('durable history overlap pagination', () => {
  it('hydrates all older pages when no contiguous baseline exists', () => {
    expect(needsOlderHistoryPage('s1', true, 500, undefined)).toBe(true)
  })

  it('stops once the tail window touches the known contiguous prefix', () => {
    expect(needsOlderHistoryPage('s1', true, 101, 100)).toBe(false)
    expect(needsOlderHistoryPage('s1', true, 80, 100)).toBe(false)
  })

  it('continues backward across a gap and validates malformed pages', () => {
    expect(needsOlderHistoryPage('s1', true, 102, 100)).toBe(true)
    expect(needsOlderHistoryPage('s1', false, undefined, 100)).toBe(false)
    expect(() => needsOlderHistoryPage('s1', true, undefined, 100)).toThrow(/invalid history pagination/)
  })
})

const event = (type: string, seq: number, data: unknown): DshEvent => ({ type, seq, time: seq, data })
const packetEvent = (seq: number): DshEvent => event('user/message', seq, {
  content: [{ type: 'text', text: `${TASK_PACKET_START}\n${JSON.stringify({
    schemaVersion: 1, taskId: 's1', completionToken: 'token', objective: 'ship it', writerMode: 'writer',
  })}\n${TASK_PACKET_END}` }],
})

describe('host error lifecycle', () => {
  it('keeps an agent error while the session stays idle and clears it on authoritative recovery', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: [packetEvent(1)] })
    const connection = connected(api)
    await connection.ensureConnected()

    api.pushHost({ payload: { type: 'host/agent-error', sessionId: 's1', message: 'agent crashed' } })
    await settleFrames()
    expect((await connection.refreshSession('s1')).hostError).toBe('agent crashed')

    api.pushHost({ payload: { type: 'host/session-status', sessionId: 's1', running: false } })
    await settleFrames()
    expect((await connection.refreshSession('s1')).hostError).toBe('agent crashed')

    api.setRunning('s1', true)
    api.pushHost({ payload: { type: 'host/session-status', sessionId: 's1', running: true } })
    await settleFrames()
    const recovered = await connection.refreshSession('s1')
    expect(recovered.hostError).toBeUndefined()
    expect(recovered.workerState).toBe('RUNNING')
  })

  it('treats a running session.list row as recovery even when the frame was missed', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: [packetEvent(1)] })
    const connection = connected(api)
    await connection.ensureConnected()

    api.pushHost({ payload: { type: 'host/agent-error', sessionId: 's1', message: 'agent crashed' } })
    await settleFrames()
    expect((await connection.refreshSession('s1')).hostError).toBe('agent crashed')

    api.setRunning('s1', true)
    expect((await connection.refreshSession('s1')).hostError).toBeUndefined()
  })

  it('drops all per-session state when the Host removes the session', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: [packetEvent(1)] })
    const connection = connected(api)
    await connection.ensureConnected()

    api.pushHost({ payload: { type: 'host/agent-error', sessionId: 's1', message: 'crashed again' } })
    await settleFrames()
    expect((await connection.refreshSession('s1')).hostError).toBe('crashed again')

    api.pushHost({ payload: { type: 'host/session-removed', sessionId: 's1' } })
    await settleFrames()
    // The row still lists in this fake (running, not recovering) to prove the
    // removal — not a running row — cleared the sticky error.
    const snapshot = await connection.refreshSession('s1')
    expect(snapshot.hostError).toBeUndefined()
  })
})

describe('stable interaction identity', () => {
  it('rejects an answer whose rpc id no longer matches the pending approval', async () => {
    const api = new FakeApi()
    api.addRow('s1', { cwd: '/work', events: [packetEvent(1)] })
    const connection = connected(api)
    await connection.ensureConnected()
    api.pushMux({
      rpcId: 'approval-current',
      payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'terminal' },
    })
    await settleFrames()

    await expect(connection.answerApproval('s1', 'approval-stale', 'allowed-once'))
      .rejects.toThrow(/stale approval rpcId/i)
    await expect(connection.answerApproval('s1', 'approval-current', 'allowed-once'))
      .resolves.toBeUndefined()
  })
})

describe('bounded event cache', () => {
  it('keeps only events at or after the latest task packet boundary', async () => {
    const api = new FakeApi()
    const events = [
      event('user/message', 1, { content: [{ type: 'text', text: 'prelude' }] }),
      event('turn/start', 2, { turn: 0 }),
      event('turn/end', 3, { turn: 0, reason: { kind: 'completed' } }),
      packetEvent(10),
      event('turn/start', 11, { turn: 1 }),
      event('step/start', 12, { turn: 1, step: 1 }),
      event('step/end', 13, { turn: 1, step: 1 }),
      event('turn/end', 14, { turn: 1, reason: { kind: 'completed' } }),
    ]
    api.addRow('s1', { cwd: '/work', events })
    const connection = connected(api)
    await connection.ensureConnected()

    const first = await connection.refreshSession('s1')
    expect(first.events.map(e => e.seq)).toEqual([10, 11, 12, 13, 14])
    expect(deriveObservation(first).asOfSeq).toBe(14)

    // A second refresh re-hydrates from history and prunes again.
    const second = await connection.refreshSession('s1')
    expect(second.events.map(e => e.seq)).toEqual([10, 11, 12, 13, 14])
  })

  it('keeps full history for a session with no task packet', async () => {
    const api = new FakeApi()
    const events = [event('turn/start', 1, { turn: 0 }), event('turn/end', 2, { turn: 0 })]
    api.addRow('s1', { cwd: '/work', events })
    const connection = connected(api)
    await connection.ensureConnected()

    const snapshot = await connection.refreshSession('s1')
    expect(snapshot.events.map(e => e.seq)).toEqual([1, 2])
  })
})
