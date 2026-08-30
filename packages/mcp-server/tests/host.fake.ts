// In-memory IApiClient used to drive real HostConnection/ConnectionController
// code paths in tests: the controller's handshake (both streams open + describe)
// completes immediately, history is served from the row's event list, and prompt
// appends a durable user/message carrying the task packet text.
import type {
  HostDescription, HostFrame, IApiClient, MuxFrame, RpcRequest, SessionSummary,
} from '@deepseek-ai/dsh-client-connection/network-client'
import { TASK_PACKET_END, TASK_PACKET_START, type DshEvent, type RecoveryCapsule } from '../src/contracts.js'
import {
  parseTaskPacket, recoveryCapsuleForRunTree, taskBoundarySeq, taskPacketEntries,
  type RecoveryCapsuleScope,
} from '../src/fold.js'
import type {
  RecoveryCapsuleRequest, TaskAdmissionReceipt, TaskAdmissionRequest,
  TokenBudgetStateReceipt, TokenBudgetStateRequest,
} from '../src/host.js'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function admissionPacket(prompt: string): Record<string, unknown> | undefined {
  const end = prompt.lastIndexOf(TASK_PACKET_END)
  const start = prompt.lastIndexOf(TASK_PACKET_START, end)
  if (start < 0 || end < 0) return undefined
  try {
    const value = JSON.parse(prompt.slice(start + TASK_PACKET_START.length, end).trim()) as unknown
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

export interface FakeRow {
  sessionId: string
  cwd?: string
  agentPreset?: string
  running: boolean
  events: DshEvent[]
}

export class FakeApi {
  readonly rows = new Map<string, FakeRow>()
  readonly childCatalog = new Map<string, Array<
    | { kind: 'child'; id: string; mode: 'one-shot' | 'continuable'; activity: 'running' | 'inactive'; hasChildren: boolean; label?: string }
    | { kind: 'diagnostic'; id: string; reason: 'corrupt' | 'unsupported' | 'unavailable' }
  >>()
  historyCalls = 0
  listCalls = 0
  promptCalls = 0
  interruptCalls = 0
  failModels = false
  resolveWriterDomain: (cwd: string) => Promise<string> = async cwd => cwd
  readonly historyPayloads: Array<{ sessionId: string; beforeSeq?: number; maxMessages?: number }> = []
  readonly modelSelections: Array<{ sessionId: string; provider: string; model: string; reasoningEffort?: string }> = []
  failAfterAdmissionOnce = false
  private admissionTail: Promise<void> = Promise.resolve()
  private readonly admissions = new Map<string, TaskAdmissionReceipt>()
  private readonly muxFrames: RpcRequest<MuxFrame>[] = []
  private readonly hostFrames: RpcRequest<HostFrame>[] = []
  private nextSeq = 1

  addRow(sessionId: string, options: { cwd?: string; agentPreset?: string; running?: boolean; events?: DshEvent[] } = {}): void {
    this.rows.set(sessionId, {
      sessionId,
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
      agentPreset: options.agentPreset ?? 'standard',
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

  addDiagnostic(
    parentSessionId: string,
    childSessionId: string,
    options: { reason?: 'corrupt' | 'unsupported' | 'unavailable'; events?: DshEvent[] } = {},
  ): void {
    this.addRow(childSessionId, { running: false, events: options.events })
    const entries = this.childCatalog.get(parentSessionId) ?? []
    entries.push({ kind: 'diagnostic', id: childSessionId, reason: options.reason ?? 'corrupt' })
    this.childCatalog.set(parentSessionId, entries)
  }

  setRunning(sessionId: string, running: boolean): void {
    const row = this.rows.get(sessionId)
    if (row !== undefined) row.running = running
    for (const entries of this.childCatalog.values()) {
      const child = entries.find(entry => entry.id === sessionId)
      if (child?.kind === 'child') child.activity = running ? 'running' : 'inactive'
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
      ...row.agentPreset === undefined ? {} : { agentPreset: row.agentPreset },
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
      history: async (payload: { sessionId: string; beforeSeq?: number; maxMessages?: number }) => {
        this.historyCalls++
        this.historyPayloads.push(payload)
        const row = this.rows.get(payload.sessionId)
        const eligible = (row?.events ?? []).filter(event => payload.beforeSeq === undefined || event.seq < payload.beforeSeq)
        const limit = payload.maxMessages ?? eligible.length
        const start = Math.max(0, eligible.length - limit)
        const events = eligible.slice(start)
        return this.ok({ events: events.map(event => ({ event })), hasMore: start > 0 })
      },
      models: async () => {
        if (this.failModels) throw new Error('model catalog unavailable')
        return this.ok({
          current: { provider: 'test-provider', model: 'test-model' },
          routable: true, groups: [], failures: [],
        })
      },
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
      interrupt: async () => {
        this.interruptCalls++
        return this.ok({ accepted: true as const })
      },
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
      const row = this.rows.get(request.sessionId)
      const currentPacket = parseTaskPacket(row?.events ?? [])
      const currentBoundary = taskBoundarySeq(row?.events ?? []) ?? -1
      const currentTerminal = row?.events.findLast(event => event.type === 'turn/end' && event.seq > currentBoundary)
      const interrupted = currentPacket?.schemaVersion === 2
        && (currentTerminal?.data as { reason?: { kind?: unknown } } | undefined)?.reason?.kind === 'interrupted'
      if (request.parentRunId !== undefined && request.recoveryCapsule !== undefined) {
        const expected = await this.recoveryCapsule({
          schemaVersion: 1, sessionId: request.sessionId, parentRunId: request.parentRunId,
        })
        if (JSON.stringify(expected) !== JSON.stringify(request.recoveryCapsule)) {
          throw new Error(`BAD_REQUEST: recoveryCapsule does not match Host durable evidence for parent run ${request.parentRunId}`)
        }
      } else if (interrupted) {
        throw new Error(`BAD_REQUEST: session ${request.sessionId} requires an exact continuation of interrupted run ${currentPacket.runId}`)
      }
      const incoming = admissionPacket(request.prompt)
      if (incoming?.writerMode === 'writer') {
        if (row?.cwd === undefined) throw new Error(`BAD_REQUEST: writer session ${request.sessionId} has no authoritative cwd`)
        const targetDomain = await this.resolveWriterDomain(row.cwd)
        for (const candidate of this.rows.values()) {
          if (candidate.cwd === undefined) continue
          const candidatePacket = parseTaskPacket(candidate.events)
          const candidateIsWriter = candidatePacket?.writerMode === 'writer'
            || candidate.events.some(event => JSON.stringify(event.data).includes('"writerMode":"writer"'))
          if (!candidateIsWriter) continue
          if (candidate.sessionId === request.sessionId && request.parentRunId !== undefined
            && request.parentRunId === (candidatePacket?.schemaVersion === 2 ? candidatePacket.runId : undefined)) continue
          const boundary = taskBoundarySeq(candidate.events) ?? -1
          const terminal = candidate.events.findLast(event => event.type === 'turn/end' && event.seq > boundary)
          const terminalKind = (terminal?.data as { reason?: { kind?: unknown } } | undefined)?.reason?.kind
          if (terminal !== undefined && terminalKind !== 'interrupted') continue
          if (await this.resolveWriterDomain(candidate.cwd) === targetDomain) {
            throw new Error(`WRITER_CONFLICT: working tree already has writer session ${candidate.sessionId}; use read_only or an independent worktree`)
          }
        }
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

  async recoveryCapsule(request: RecoveryCapsuleRequest): Promise<RecoveryCapsule> {
    const root = this.rows.get(request.sessionId)
    const packet = parseTaskPacket(root?.events ?? [])
    if (root === undefined || packet?.schemaVersion !== 2 || packet.runId !== request.parentRunId) {
      throw new Error(`parent run ${request.parentRunId} is not the current durable interrupted run for session ${request.sessionId}`)
    }
    const activationSeq = taskBoundarySeq(root.events) ?? -1
    const rootBoundary = root.events.find(event => event.seq === activationSeq)
    const terminal = root.events.findLast(event => event.type === 'turn/end' && event.seq > activationSeq)
    const reason = (terminal?.data as { reason?: { kind?: unknown } } | undefined)?.reason?.kind
    if (root.running || terminal === undefined || reason !== 'interrupted' || rootBoundary === undefined) {
      throw new Error(`parent run ${request.parentRunId} is not the current durable interrupted run for session ${request.sessionId}`)
    }
    const scopes: RecoveryCapsuleScope[] = []
    const visit = (parentSessionId: string): void => {
      for (const entry of this.childCatalog.get(parentSessionId) ?? []) {
        const child = this.rows.get(entry.id)
        if (child === undefined) throw new Error(`affiliated child ${entry.id} is unavailable`)
        const nested = taskPacketEntries(child.events).findLast(({ packet: childPacket, seq }) => {
          const boundary = child.events.find(event => event.seq === seq)
          return childPacket.schemaVersion === 2 && childPacket.sessionId === entry.id
            && boundary !== undefined && boundary.time >= rootBoundary.time
        })
        if (nested?.packet.schemaVersion === 2 && nested.packet.runId !== request.parentRunId) continue
        const activation = child.events.find(event => event.type === 'user/message'
          && event.time >= rootBoundary.time
          && (() => {
            const childPacket = parseTaskPacket([event])
            return childPacket === undefined || (childPacket.schemaVersion === 2
              && childPacket.sessionId === entry.id && childPacket.runId === request.parentRunId)
          })())
        if (activation === undefined) continue
        const childTerminal = child.events.findLast(event => event.type === 'turn/end' && event.seq > activation.seq)
        const childStart = child.events.findLast(event => event.type === 'turn/start' && event.seq > activation.seq)
        if (entry.kind === 'diagnostic' || entry.activity === 'running' || childTerminal === undefined
          || (childStart !== undefined && childStart.seq > childTerminal.seq)) {
          throw new Error(`affiliated child ${entry.id} is incomplete`)
        }
        scopes.push({
          sessionId: entry.id,
          events: child.events,
          activationSeq: activation.seq,
          terminalSeq: childTerminal.seq,
          cwd: root.cwd,
        })
        visit(entry.id)
      }
    }
    visit(request.sessionId)
    return recoveryCapsuleForRunTree({
      hostInstanceId: 'host-1',
      events: root.events,
      workerState: 'IDLE',
      ...root.cwd === undefined ? {} : { cwd: root.cwd },
    }, packet, terminal, scopes)
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
