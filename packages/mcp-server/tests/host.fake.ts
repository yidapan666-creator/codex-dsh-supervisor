// In-memory IApiClient used to drive real HostConnection/ConnectionController
// code paths in tests: the controller's handshake (both streams open + describe)
// completes immediately, history is served from the row's event list, and prompt
// appends a durable user/message carrying the task packet text.
import type {
  HostDescription, HostFrame, IApiClient, MuxFrame, RpcRequest, SessionSummary,
} from '@deepseek-ai/dsh-client-connection/network-client'
import type { DshEvent } from '../src/contracts.js'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export interface FakeRow {
  sessionId: string
  cwd?: string
  running: boolean
  events: DshEvent[]
}

export class FakeApi {
  readonly rows = new Map<string, FakeRow>()
  private readonly muxFrames: RpcRequest<MuxFrame>[] = []
  private readonly hostFrames: RpcRequest<HostFrame>[] = []
  private nextSeq = 1

  addRow(sessionId: string, options: { cwd?: string; running?: boolean; events?: DshEvent[] } = {}): void {
    this.rows.set(sessionId, {
      sessionId,
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
      running: options.running ?? false,
      events: [...(options.events ?? [])],
    })
  }

  setRunning(sessionId: string, running: boolean): void {
    const row = this.rows.get(sessionId)
    if (row !== undefined) row.running = running
  }

  setEvents(sessionId: string, events: DshEvent[]): void {
    const row = this.rows.get(sessionId)
    if (row !== undefined) row.events = [...events]
  }

  pushMux(frame: RpcRequest<MuxFrame>): void {
    this.muxFrames.push(frame)
  }

  pushHost(frame: RpcRequest<HostFrame>): void {
    this.hostFrames.push(frame)
  }

  private listItems(): SessionSummary[] {
    return [...this.rows.values()].map(row => ({
      sessionId: row.sessionId,
      updatedAt: 1,
      running: row.running,
      blank: false,
      ...row.cwd === undefined ? {} : { cwd: row.cwd },
    }))
  }

  private ok<T>(value: T): { result: { ok: true; value: T } } {
    return { result: { ok: true, value } }
  }

  private stream<T>(queue: T[], signal: AbortSignal, onOpen?: () => void): AsyncIterable<T> {
    onOpen?.()
    return {
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          const next = queue.shift()
          if (next !== undefined) yield next
          else await sleep(5)
        }
      },
    }
  }

  readonly api = {
    sessions: {
      list: async () => this.ok({ items: this.listItems() }),
      history: async (payload: { sessionId: string }) => {
        const row = this.rows.get(payload.sessionId)
        const events = row?.events ?? []
        return this.ok({ events: events.map(event => ({ event })), hasMore: false })
      },
      models: async () => this.ok({
        current: { provider: 'test-provider', model: 'test-model' },
        routable: true, groups: [], failures: [],
      }),
      selectModel: async () => this.ok({ selected: true }),
      prompt: async (payload: { sessionId: string; content: { type: string; text: string }[] }) => {
        const row = this.rows.get(payload.sessionId)
        if (row === undefined) return { result: { ok: false as const, error: { code: 'SESSION_NOT_FOUND', message: 'no such session' } } }
        const text = payload.content.map(block => block.text).join('\n')
        const seq = this.nextSeq++
        row.events = [...row.events, {
          type: 'user/message', seq, time: Date.now(),
          data: { content: [{ type: 'text', text }] },
        }]
        return this.ok({ accepted: true })
      },
    },
    host: {
      describe: async (): Promise<{ result: { ok: true; value: HostDescription } }> => this.ok({
        protocolVersion: 1,
        hostInstanceId: 'host-1',
        version: '0.1.0-rc.8',
        cwd: '/tmp',
        attachedSessions: 0,
        home: '/tmp',
        canOpenPath: false,
      }),
    },
    events: {
      mux: (_payload: unknown, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>> =>
        this.stream(this.muxFrames, signal, onOpen),
      host: (_payload: unknown, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<HostFrame>> =>
        this.stream(this.hostFrames, signal, onOpen),
    },
    respond: async () => ({ accepted: true }),
  } as unknown as IApiClient
}

/** Let a queued frame be pumped into the controller's sinks before asserting. */
export async function settleFrames(ms = 30): Promise<void> {
  await sleep(ms)
}
