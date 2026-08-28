// In-memory IApiClient used to drive real HostConnection/ConnectionController
// code paths in tests: the controller's handshake (both streams open + describe)
// completes immediately, history is served from the row's event list, and prompt
// appends a durable user/message carrying the task packet text.
import type {
  HostDescription, HostFrame, IApiClient, MuxFrame, RpcRequest, SessionSummary,
} from '@deepseek-ai/dsh-client-connection/network-client'
import type { DshEvent } from '../src/contracts.js'
import { parseTaskPacket } from '../src/fold.js'
import type {
  TaskAdmissionReceipt, TaskAdmissionRequest, TokenBudgetStateReceipt, TokenBudgetStateRequest,
} from '../src/host.js'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export interface FakeRow {
  sessionId: string
  cwd?: string
  running: boolean
  events: DshEvent[]
}

export class FakeApi {
  readonly rows = new Map<string, FakeRow>()
  readonly childCatalog = new Map<string, Array<{
    kind: 'child'; id: string; mode: 'one-shot' | 'continuable'; activity: 'running' | 'inactive'; hasChildren: boolean; label?: string
  }>>()
  historyCalls = 0
  listCalls = 0
  promptCalls = 0
  readonly modelSelections: Array<{ sessionId: string; provider: string; model: string; reasoningEffort?: string }> = []
  failAfterAdmissionOnce = false
  private admissionTail: Promise<void> = Promise.resolve()
  private readonly admissions = new Map<string, TaskAdmissionReceipt>()
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

  addChild(
    parentSessionId: string,
    childSessionId: string,
    options: { mode?: 'one-shot' | 'continuable'; running?: boolean; events?: DshEvent[]; hasChildren?: boolean } = {},
  ): void {
    this.addRow(childSessionId, { running: options.running, events: options.events })
    const mode = options.mode ?? 'one-shot'
    const entries = this.childCatalog.get(parentSessionId) ?? []
    entries.push({
      kind: 'child',
      id: childSessionId,
      mode,
      activity: options.running === true ? 'running' : 'inactive',
      hasChildren: options.hasChildren ?? false,
      ...mode === 'continuable' ? { label: childSessionId } : {},
    })
    this.childCatalog.set(parentSessionId, entries)
  }

  setRunning(sessionId: string, running: boolean): void {
    const row = this.rows.get(sessionId)
    if (row !== undefined) row.running = running
    for (const entries of this.childCatalog.values()) {
      const child = entries.find(entry => entry.id === sessionId)
      if (child !== undefined) child.activity = running ? 'running' : 'inactive'
    }
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
      list: async () => {
        this.listCalls++
        return this.ok({ items: this.listItems() })
      },
      history: async (payload: { sessionId: string }) => {
        this.historyCalls++
        const row = this.rows.get(payload.sessionId)
        const events = row?.events ?? []
        return this.ok({ events: events.map(event => ({ event })), hasMore: false })
      },
      models: async () => this.ok({
        current: { provider: 'test-provider', model: 'test-model' },
        routable: true, groups: [], failures: [],
      }),
      selectModel: async (payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string }) => {
        this.modelSelections.push(payload)
        return this.ok({ selected: true })
      },
      prompt: async (payload: { sessionId: string; content: { type: string; text: string }[] }) => {
        this.promptCalls++
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
    subagents: {
      list: async (payload: { parentSessionId: string }) => this.ok({
        entries: this.childCatalog.get(payload.parentSessionId) ?? [],
        parentAvailable: this.rows.has(payload.parentSessionId),
      }),
      history: async (payload: { childSessionId: string }) => {
        const events = this.rows.get(payload.childSessionId)?.events ?? []
        return this.ok({ events: events.map(event => ({ event })), hasMore: false })
      },
      interrupt: async () => this.ok({ accepted: true as const }),
    },
    respond: async () => ({ accepted: true }),
  } as unknown as IApiClient

  async admitTask(request: TaskAdmissionRequest): Promise<TaskAdmissionReceipt> {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const previous = this.admissionTail
    this.admissionTail = previous.then(() => gate)
    await previous
    try {
      const key = `${request.sessionId}:${request.requestId}`
      const existing = this.admissions.get(key)
      if (existing !== undefined) {
        if (existing.requestDigest !== request.requestDigest) {
          throw new Error(`REQUEST_ID_CONFLICT: requestId ${request.requestId} was already used with a different task payload`)
        }
        return { ...existing, reconciled: true }
      }
      await this.api.sessions.selectModel({
        sessionId: request.sessionId as never,
        provider: request.modelSelection.provider,
        model: request.modelSelection.model,
        ...request.modelSelection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.modelSelection.reasoningEffort },
      } as never)
      const prompt = await this.api.sessions.prompt({
        sessionId: request.sessionId as never,
        mode: 'queue',
        content: [{ type: 'text', text: request.prompt }],
      }) as unknown as { result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } } }
      if (!prompt.result.ok) throw new Error(`${prompt.result.error.code}: ${prompt.result.error.message}`)
      const row = this.rows.get(request.sessionId)
      const receipt: TaskAdmissionReceipt = {
        schemaVersion: 1,
        sessionId: request.sessionId,
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        runId: request.runId,
        reconciled: false,
        asOfSeq: row?.events.at(-1)?.seq ?? -1,
      }
      this.admissions.set(key, receipt)
      if (this.failAfterAdmissionOnce) {
        this.failAfterAdmissionOnce = false
        throw new Error('simulated response loss after durable admission')
      }
      return receipt
    } finally {
      release()
    }
  }

  async tokenBudgetState(request: TokenBudgetStateRequest): Promise<TokenBudgetStateReceipt> {
    const related = new Set([request.sessionId])
    const visit = (parent: string): void => {
      for (const child of this.childCatalog.get(parent) ?? []) {
        related.add(child.id)
        visit(child.id)
      }
    }
    visit(request.sessionId)
    let limitTokens = 0
    let uncachedInputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let minimumUsedTokens = 0
    const rootPacket = parseTaskPacket(this.rows.get(request.sessionId)?.events ?? [])
    if (rootPacket?.schemaVersion === 2 && rootPacket.runId === request.runId) {
      limitTokens = rootPacket.budget?.maxTokens ?? 0
    }
    for (const id of related) {
      for (const event of this.rows.get(id)?.events ?? []) {
        const text = JSON.stringify(event.data)
        const hook = text.match(new RegExp(`token-budget-exhausted;runId=${request.runId};used=(\\d+);limit=(\\d+)`))
        if (hook !== null) {
          minimumUsedTokens = Math.max(minimumUsedTokens, Number(hook[1]))
          limitTokens = Number(hook[2])
        }
        const data = event.data as { usage?: Record<string, unknown> }
        if (event.type === 'assistant/message' && data.usage !== undefined) {
          uncachedInputTokens += Number(data.usage.inputTokens ?? 0)
          outputTokens += Number(data.usage.outputTokens ?? 0)
          cacheReadTokens += Number(data.usage.cacheReadTokens ?? 0)
          cacheWriteTokens += Number(data.usage.cacheWriteTokens ?? 0)
        }
      }
    }
    if (limitTokens <= 0) throw new Error(`run ${request.runId} has no Host-enforced token budget`)
    const sampledTokens = uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    if (minimumUsedTokens > sampledTokens) uncachedInputTokens += minimumUsedTokens - sampledTokens
    const usedTokens = uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    return {
      schemaVersion: 1,
      sessionId: request.sessionId,
      runId: request.runId,
      limitTokens,
      usedTokens,
      remainingTokens: Math.max(0, limitTokens - usedTokens),
      exhausted: usedTokens >= limitTokens,
      sessions: related.size,
      uncachedInputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      coverage: 'run_tree',
      enforcement: 'DSH_HOST_RUNTIME',
      overshootBound: 'IN_FLIGHT_MODEL_RESPONSES',
    }
  }
}

/** Let a queued frame be pumped into the controller's sinks before asserting. */
export async function settleFrames(ms = 30): Promise<void> {
  await sleep(ms)
}
