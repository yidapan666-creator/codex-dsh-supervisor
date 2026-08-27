import { spawn } from 'node:child_process'
import {
  ConnectionController,
  WebApiClient,
  type HostDescription,
  type HostFrame,
  type IApiClient,
  type MuxFrame,
  type RpcRequest,
  type SessionId,
  type SessionSummary,
} from '@deepseek-ai/dsh-client-connection/network-client'
import { taskBoundarySeq } from './fold.js'
import type {
  DshEvent, PendingApproval, PendingQuestion, TaskRuntimeState, WorkerState,
} from './contracts.js'

export interface HostLaunchConfig {
  argv: string[]
  cwd?: string
}

export type SessionSnapshot = TaskRuntimeState

export interface TaskAdmissionRequest {
  schemaVersion: 1
  sessionId: string
  requestId: string
  requestDigest: string
  runId: string
  prompt: string
}

export interface TaskAdmissionReceipt {
  schemaVersion: 1
  sessionId: string
  requestId: string
  requestDigest: string
  runId: string
  reconciled: boolean
  asOfSeq: number
}

export type TaskAdmissionTransport = (request: TaskAdmissionRequest) => Promise<TaskAdmissionReceipt>

interface CachedSessionMetadata {
  cwd?: string
  telemetry?: TaskRuntimeState['telemetry']
}

function unwrap<T>(response: { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } } }): T {
  if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`)
  return response.result.value
}

function taskAdmissionReceipt(value: unknown, request: TaskAdmissionRequest): TaskAdmissionReceipt {
  if (typeof value !== 'object' || value === null) throw new Error('malformed dsh-gate admission receipt')
  const receipt = value as Record<string, unknown>
  if (receipt.schemaVersion !== 1
    || receipt.sessionId !== request.sessionId
    || receipt.requestId !== request.requestId
    || receipt.requestDigest !== request.requestDigest
    || typeof receipt.runId !== 'string'
    || typeof receipt.reconciled !== 'boolean'
    || typeof receipt.asOfSeq !== 'number' || !Number.isSafeInteger(receipt.asOfSeq)) {
    throw new Error('malformed dsh-gate admission receipt')
  }
  return receipt as unknown as TaskAdmissionReceipt
}

async function postTaskAdmission(baseUrl: string, request: TaskAdmissionRequest): Promise<TaskAdmissionReceipt> {
  const rpcId = `dsh-gate-admit-${request.requestId}`
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/dsh-gate.admit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'dsh-gate.admit', payload: request }),
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) {
    throw new Error('PROTOCOL_ERROR: DSH Host does not expose atomic task admission; reinstall the supervisor plugin and restart the Host')
  }
  if (!response.ok) throw new Error(`dsh-gate admission carrier returned HTTP ${String(response.status)}`)
  const value = await response.json() as unknown
  if (typeof value !== 'object' || value === null) throw new Error('malformed dsh-gate admission response')
  const envelope = value as Record<string, unknown>
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId
    || typeof envelope.result !== 'object' || envelope.result === null) {
    throw new Error('malformed dsh-gate admission response')
  }
  const result = envelope.result as Record<string, unknown>
  if (result.ok === false) {
    const error = typeof result.error === 'object' && result.error !== null
      ? result.error as Record<string, unknown>
      : {}
    throw new Error(`${String(error.code ?? 'INTERNAL')}: ${String(error.message ?? 'task admission failed')}`)
  }
  if (result.ok !== true) throw new Error('malformed dsh-gate admission result')
  return taskAdmissionReceipt(result.value, request)
}

export function needsOlderHistoryPage(
  sessionId: string,
  hasMore: boolean,
  firstSeq: number | undefined,
  knownHistoryAsOf: number | undefined,
): boolean {
  if (!hasMore) return false
  if (firstSeq === undefined || firstSeq <= 0) throw new Error(`invalid history pagination for ${sessionId}`)
  return knownHistoryAsOf === undefined || firstSeq > knownHistoryAsOf + 1
}

/** Start a configured DSH Host without tying its lifetime to this MCP process. */
export function launchDetachedHost(config: HostLaunchConfig): Promise<void> {
  const [command, ...args] = config.argv
  if (command === undefined || command.trim() === '') throw new Error('DSH host launch argv must not be empty')
  const child = spawn(command, args, {
    cwd: config.cwd,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  return new Promise((resolve, reject) => {
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
    child.once('error', reject)
  })
}

export class HostConnection {
  private readonly controller: ConnectionController
  private description: HostDescription | undefined
  private protocolError: string | undefined
  private readonly listeners = new Set<() => void>()
  private readonly events = new Map<string, Map<number, DshEvent>>()
  /** Highest sequence through which history pagination has established a contiguous durable prefix. */
  private readonly historyAsOf = new Map<string, number>()
  private readonly running = new Map<string, boolean>()
  private readonly hostErrors = new Map<string, string>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly questions = new Map<string, PendingQuestion>()
  private readonly metadata = new Map<string, CachedSessionMetadata>()

  constructor(
    readonly baseUrl: string,
    readonly api: IApiClient = new WebApiClient(baseUrl),
    private readonly admissionTransport: TaskAdmissionTransport = request => postTaskAdmission(baseUrl, request),
  ) {
    this.controller = new ConnectionController(this.api, {
      onConnected: (description) => {
        this.description = description
        this.protocolError = description.protocolVersion === 1
          ? undefined
          : `unsupported DSH Host protocol version ${String(description.protocolVersion)} (expected 1)`
        this.publish()
      },
      onStateChange: (state) => {
        if (state === 'reconnecting') this.description = undefined
        this.publish()
      },
      onMuxEnvelope: envelope => this.onMux(envelope),
      onHostEnvelope: envelope => this.onHost(envelope),
    })
    this.controller.start()
  }

  stopClient(): void {
    this.controller.stop()
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private onMux(envelope: RpcRequest<MuxFrame>): void {
    const frame = envelope.payload
    if (frame.type === 'session/event') {
      const sessionEvents = this.events.get(frame.sessionId) ?? new Map<number, DshEvent>()
      sessionEvents.set(frame.event.seq, frame.event as DshEvent)
      this.events.set(frame.sessionId, sessionEvents)
    } else if (frame.type === 'approval/requested') {
      this.approvals.set(frame.sessionId, {
        rpcId: envelope.rpcId,
        approvalId: frame.approvalId,
        toolName: frame.toolName,
        ...frame.callId === undefined ? {} : { callId: frame.callId },
        ...frame.reason === undefined ? {} : { reason: frame.reason },
      })
    } else if (frame.type === 'approval/resolved') {
      this.approvals.delete(frame.sessionId)
    } else if (frame.type === 'question/requested') {
      this.questions.set(frame.sessionId, { rpcId: envelope.rpcId, questions: frame.questions })
    } else if (frame.type === 'question/resolved') {
      this.questions.delete(frame.sessionId)
    }
    this.publish()
  }

  private onHost(envelope: RpcRequest<HostFrame>): void {
    const frame = envelope.payload
    if (frame.type === 'host/session-status') {
      this.running.set(frame.sessionId, frame.running)
      // The Host observing the agent running again is the authoritative recovery
      // signal for a previously reported agent error; an idle session keeps it.
      if (frame.running) this.hostErrors.delete(frame.sessionId)
    } else if (frame.type === 'host/agent-error') {
      this.hostErrors.set(frame.sessionId, frame.message)
    } else if (frame.type === 'host/session-removed') {
      this.dropSession(frame.sessionId)
    }
    this.publish()
  }

  /** Drop all in-memory state for a session the Host no longer tracks. */
  private dropSession(sessionId: string): void {
    this.events.delete(sessionId)
    this.historyAsOf.delete(sessionId)
    this.running.delete(sessionId)
    this.hostErrors.delete(sessionId)
    this.approvals.delete(sessionId)
    this.questions.delete(sessionId)
    this.metadata.delete(sessionId)
  }

  async ensureConnected(timeoutMs = 10_000): Promise<HostDescription> {
    if (this.protocolError !== undefined) throw new Error(this.protocolError)
    if (this.description !== undefined) return this.description
    return new Promise<HostDescription>((resolve, reject) => {
      const timer = setTimeout(() => {
        dispose()
        reject(new Error(`timed out connecting to DSH Host at ${this.baseUrl}`))
      }, timeoutMs)
      const dispose = this.subscribe(() => {
        if (this.protocolError !== undefined) {
          clearTimeout(timer)
          dispose()
          reject(new Error(this.protocolError))
        } else if (this.description !== undefined) {
          clearTimeout(timer)
          dispose()
          resolve(this.description)
        }
      })
    })
  }

  currentDescription(): HostDescription | undefined {
    return this.description
  }

  /** Atomically queue one idempotent supervised task through the Host plugin. */
  admitTask(request: TaskAdmissionRequest): Promise<TaskAdmissionReceipt> {
    return this.admissionTransport(request)
  }

  async listSessions(): Promise<SessionSummary[]> {
    return unwrap(await this.api.sessions.list({})).items
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    const items = unwrap(await this.api.sessions.list({})).items
    return items.some(item => item.sessionId === sessionId)
  }

  async refreshSession(sessionId: string): Promise<SessionSnapshot> {
    const items = unwrap(await this.api.sessions.list({})).items
    const row = items.find(item => item.sessionId === sessionId)
    if (row === undefined) throw new Error(`DSH session not found: ${sessionId}`)
    this.running.set(sessionId, row.running)
    // session.list is the Host's current truth: a running row also clears a
    // sticky agent error that arrived while this client was disconnected.
    if (row.running) this.hostErrors.delete(sessionId)
    let projections = row.projections
    let beforeSeq: number | undefined
    let hasMore = true
    const store = this.events.get(sessionId) ?? new Map<number, DshEvent>()
    const knownHistoryAsOf = this.historyAsOf.get(sessionId)
    let refreshedHistoryAsOf = knownHistoryAsOf
    let tailAsOf: number | undefined
    while (hasMore) {
      const page = unwrap(await this.api.sessions.history({
        sessionId: sessionId as SessionId,
        maxMessages: knownHistoryAsOf === undefined ? 200 : 1,
        ...beforeSeq === undefined ? {} : { beforeSeq },
      }))
      projections ??= page.projections
      for (const entry of page.events) store.set(entry.event.seq, entry.event as DshEvent)
      this.events.set(sessionId, store)
      hasMore = page.hasMore
      const first = page.events.at(0)?.event.seq
      const last = page.events.at(-1)?.event.seq
      tailAsOf ??= last
      if (!needsOlderHistoryPage(sessionId, hasMore, first, knownHistoryAsOf)) break
      beforeSeq = first
    }
    if (tailAsOf !== undefined) refreshedHistoryAsOf = Math.max(refreshedHistoryAsOf ?? -1, tailAsOf)
    if (refreshedHistoryAsOf !== undefined) this.historyAsOf.set(sessionId, refreshedHistoryAsOf)
    // Bound the in-memory cache to the latest supervised task boundary: events
    // older than it are never used by the fold and can be re-fetched from the
    // authoritative Host. Sessions without a task packet keep their history.
    const boundary = taskBoundarySeq([...store.values()])
    if (boundary !== undefined) {
      for (const seq of [...store.keys()]) if (seq < boundary) store.delete(seq)
    }
    const description = await this.ensureConnected()
    const pendingApproval = this.approvals.get(sessionId)
    const pendingQuestion = this.questions.get(sessionId)
    const hostError = this.hostErrors.get(sessionId)
    const telemetryValues = projections?.values as Record<string, unknown> | undefined
    const telemetry = projections === undefined ? undefined : {
      asOfSeq: projections.asOfSeq,
      ...telemetryValues?.tokenUsage === undefined ? {} : { tokenUsage: telemetryValues.tokenUsage },
      ...telemetryValues?.sessionStats === undefined ? {} : { sessionStats: telemetryValues.sessionStats },
      ...telemetryValues?.subagent === undefined ? {} : { subagent: telemetryValues.subagent },
    }
    this.metadata.set(sessionId, {
      ...row.cwd === undefined ? {} : { cwd: row.cwd },
      ...telemetry === undefined ? {} : { telemetry },
    })
    return this.cachedSession(sessionId) ?? {
      hostInstanceId: description.hostInstanceId,
      events: [...(this.events.get(sessionId)?.values() ?? [])].sort((a, b) => a.seq - b.seq),
      workerState: this.running.get(sessionId) === true ? 'RUNNING' : this.running.get(sessionId) === false ? 'IDLE' : 'UNKNOWN',
      ...pendingApproval === undefined ? {} : { pendingApproval },
      ...pendingQuestion === undefined ? {} : { pendingQuestion },
      ...hostError === undefined ? {} : { hostError },
      ...telemetry === undefined ? {} : { telemetry },
      ...row.cwd === undefined ? {} : { cwd: row.cwd },
    }
  }

  /** Build a no-I/O snapshot from mux/host frames plus the last authoritative metadata. */
  cachedSession(sessionId: string): SessionSnapshot | undefined {
    const description = this.description
    const metadata = this.metadata.get(sessionId)
    if (description === undefined || metadata === undefined) return undefined
    const pendingApproval = this.approvals.get(sessionId)
    const pendingQuestion = this.questions.get(sessionId)
    const hostError = this.hostErrors.get(sessionId)
    return {
      hostInstanceId: description.hostInstanceId,
      events: [...(this.events.get(sessionId)?.values() ?? [])].sort((a, b) => a.seq - b.seq),
      workerState: this.running.get(sessionId) === true ? 'RUNNING' : this.running.get(sessionId) === false ? 'IDLE' : 'UNKNOWN',
      ...pendingApproval === undefined ? {} : { pendingApproval },
      ...pendingQuestion === undefined ? {} : { pendingQuestion },
      ...hostError === undefined ? {} : { hostError },
      ...metadata.telemetry === undefined ? {} : { telemetry: metadata.telemetry },
      ...metadata.cwd === undefined ? {} : { cwd: metadata.cwd },
    }
  }

  waitForChange(timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { dispose(); resolve(false) }, timeoutMs)
      const dispose = this.subscribe(() => { clearTimeout(timer); dispose(); resolve(true) })
    })
  }

  async answerApproval(sessionId: string, rpcId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const pending = this.approvals.get(sessionId)
    if (pending === undefined) throw new Error(`no pending approval for ${sessionId}`)
    if (pending.rpcId !== rpcId) throw new Error(`stale approval rpcId ${rpcId}; active rpcId is ${pending.rpcId}`)
    const receipt = await this.api.respond({
      type: 'client-response', rpcId: pending.rpcId as never,
      result: { ok: true, value: { sessionId, approvalId: pending.approvalId, outcome } },
    })
    if (!receipt.accepted) throw new Error(`approval response rejected: ${receipt.reason}`)
  }

  async answerQuestion(sessionId: string, rpcId: string, answers: { id: string; selected: string[]; custom?: string | undefined }[]): Promise<void> {
    const pending = this.questions.get(sessionId)
    if (pending === undefined) throw new Error(`no pending question for ${sessionId}`)
    if (pending.rpcId !== rpcId) throw new Error(`stale question rpcId ${rpcId}; active rpcId is ${pending.rpcId}`)
    const receipt = await this.api.respond({
      type: 'client-response', rpcId: pending.rpcId as never,
      result: { ok: true, value: { sessionId, answer: { answers } } },
    })
    if (!receipt.accepted) throw new Error(`question response rejected: ${receipt.reason}`)
  }
}

export function parseLaunchConfig(value: string | undefined): HostLaunchConfig | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = JSON.parse(value) as { argv?: unknown; cwd?: unknown }
  if (!Array.isArray(parsed.argv) || !parsed.argv.every(item => typeof item === 'string')) {
    throw new Error('DSH_HOST_LAUNCH must be JSON with a string[] argv')
  }
  return { argv: parsed.argv, ...typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {} }
}
