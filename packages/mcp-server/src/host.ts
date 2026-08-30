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
  DshEvent, PendingApproval, PendingQuestion, RecoveryCapsule, TaskRuntimeState, WorkerState,
} from './contracts.js'
import {
  APPROVAL_REASON_LIMIT,
  APPROVAL_TOOL_NAME_LIMIT,
  FAILURE_MESSAGE_LIMIT,
  INTERACTION_ID_LIMIT,
  QUESTION_COUNT_LIMIT,
  QUESTION_DETAIL_LIMIT,
  QUESTION_HEADER_LIMIT,
  QUESTION_ID_LIMIT,
  QUESTION_OPTION_DESCRIPTION_LIMIT,
  QUESTION_OPTION_LABEL_LIMIT,
  QUESTION_OPTIONS_LIMIT,
  QUESTION_TEXT_LIMIT,
  recoveryCapsuleSchema,
  telemetrySessionStatsSchema,
  telemetrySubagentSchema,
  telemetryTokenUsageSchema,
} from './contracts.js'

export interface HostLaunchConfig {
  argv: string[]
  cwd?: string
}

export type SessionSnapshot = TaskRuntimeState

/** A reachable Host violated the pinned wire/plugin contract; retrying unchanged cannot fix it. */
export class ProtocolContractError extends Error {
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'ProtocolContractError'
  }
}

export interface TaskAdmissionRequest {
  schemaVersion: 1
  sessionId: string
  requestId: string
  requestDigest: string
  runId: string
  parentRunId?: string
  recoveryCapsule?: RecoveryCapsule
  prompt: string
  modelSelection: {
    provider: string
    model: string
    reasoningEffort?: string
  }
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

export interface RecoveryCapsuleRequest {
  schemaVersion: 1
  sessionId: string
  parentRunId: string
}

export type RecoveryCapsuleTransport = (request: RecoveryCapsuleRequest) => Promise<RecoveryCapsule>

export interface TokenBudgetStateRequest {
  schemaVersion: 1
  sessionId: string
  runId: string
}

export interface TokenBudgetStateReceipt {
  schemaVersion: 1
  sessionId: string
  runId: string
  limitTokens: number
  usedTokens: number
  remainingTokens: number
  exhausted: boolean
  sessions: number
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  coverage: 'run_tree'
  enforcement: 'DSH_HOST_RUNTIME'
  overshootBound: 'IN_FLIGHT_MODEL_RESPONSES'
}

export type TokenBudgetStateTransport = (request: TokenBudgetStateRequest) => Promise<TokenBudgetStateReceipt>

interface CachedSessionMetadata {
  cwd?: string
  agentPreset?: string
  telemetry?: TaskRuntimeState['telemetry']
}

function unwrap<T>(response: { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } } }): T {
  if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`)
  return response.result.value
}

function taskAdmissionReceipt(value: unknown, request: TaskAdmissionRequest): TaskAdmissionReceipt {
  if (typeof value !== 'object' || value === null) throw new ProtocolContractError('malformed dsh-gate admission receipt')
  const receipt = value as Record<string, unknown>
  if (receipt.schemaVersion !== 1
    || receipt.sessionId !== request.sessionId
    || receipt.requestId !== request.requestId
    || receipt.requestDigest !== request.requestDigest
    || typeof receipt.runId !== 'string'
    || typeof receipt.reconciled !== 'boolean'
    || typeof receipt.asOfSeq !== 'number' || !Number.isSafeInteger(receipt.asOfSeq)) {
    throw new ProtocolContractError('malformed dsh-gate admission receipt')
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
    throw new ProtocolContractError('DSH Host does not expose atomic task admission; reinstall the supervisor plugin and restart the Host')
  }
  if (!response.ok) throw new Error(`dsh-gate admission carrier returned HTTP ${String(response.status)}`)
  const value = await response.json() as unknown
  if (typeof value !== 'object' || value === null) throw new ProtocolContractError('malformed dsh-gate admission response')
  const envelope = value as Record<string, unknown>
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId
    || typeof envelope.result !== 'object' || envelope.result === null) {
    throw new ProtocolContractError('malformed dsh-gate admission response')
  }
  const result = envelope.result as Record<string, unknown>
  if (result.ok === false) {
    const error = typeof result.error === 'object' && result.error !== null
      ? result.error as Record<string, unknown>
      : {}
    throw new Error(`${String(error.code ?? 'INTERNAL')}: ${String(error.message ?? 'task admission failed')}`)
  }
  if (result.ok !== true) throw new ProtocolContractError('malformed dsh-gate admission result')
  return taskAdmissionReceipt(result.value, request)
}

function recoveryCapsuleReceipt(value: unknown, request: RecoveryCapsuleRequest): RecoveryCapsule {
  const parsed = recoveryCapsuleSchema.safeParse(value)
  if (!parsed.success
    || parsed.data.runTree.sessions[0]?.sessionId !== request.sessionId
    || parsed.data.parentRunId !== request.parentRunId) {
    throw new ProtocolContractError('malformed dsh-gate recovery capsule receipt')
  }
  return parsed.data
}

async function postRecoveryCapsule(
  baseUrl: string,
  request: RecoveryCapsuleRequest,
): Promise<RecoveryCapsule> {
  const rpcId = `dsh-gate-recovery-${request.parentRunId}`
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/dsh-gate.recovery-capsule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId, method: 'dsh-gate.recovery-capsule', payload: request,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) {
    throw new ProtocolContractError('DSH Host does not expose durable recovery capsules; reinstall the supervisor plugin and restart the Host')
  }
  if (!response.ok) throw new Error(`dsh-gate recovery carrier returned HTTP ${String(response.status)}`)
  const envelope = await response.json() as Record<string, unknown>
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId
    || typeof envelope.result !== 'object' || envelope.result === null) {
    throw new ProtocolContractError('malformed dsh-gate recovery capsule response')
  }
  const result = envelope.result as Record<string, unknown>
  if (result.ok === false) {
    const error = typeof result.error === 'object' && result.error !== null
      ? result.error as Record<string, unknown>
      : {}
    throw new Error(`${String(error.code ?? 'INTERNAL')}: ${String(error.message ?? 'recovery capsule failed')}`)
  }
  if (result.ok !== true) throw new ProtocolContractError('malformed dsh-gate recovery capsule result')
  return recoveryCapsuleReceipt(result.value, request)
}

function tokenBudgetStateReceipt(value: unknown, request: TokenBudgetStateRequest): TokenBudgetStateReceipt {
  if (typeof value !== 'object' || value === null) throw new ProtocolContractError('malformed dsh-gate token budget state receipt')
  const receipt = value as Record<string, unknown>
  if (receipt.schemaVersion !== 1
    || receipt.sessionId !== request.sessionId
    || receipt.runId !== request.runId
    || typeof receipt.limitTokens !== 'number' || !Number.isSafeInteger(receipt.limitTokens) || receipt.limitTokens <= 0
    || typeof receipt.usedTokens !== 'number' || !Number.isSafeInteger(receipt.usedTokens) || receipt.usedTokens < 0
    || typeof receipt.remainingTokens !== 'number' || !Number.isSafeInteger(receipt.remainingTokens) || receipt.remainingTokens < 0
    || typeof receipt.exhausted !== 'boolean'
    || typeof receipt.sessions !== 'number' || !Number.isSafeInteger(receipt.sessions) || receipt.sessions < 0
    || receipt.coverage !== 'run_tree'
    || receipt.enforcement !== 'DSH_HOST_RUNTIME'
    || receipt.overshootBound !== 'IN_FLIGHT_MODEL_RESPONSES') {
    throw new ProtocolContractError('malformed dsh-gate token budget state receipt')
  }
  for (const key of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    if (typeof receipt[key] !== 'number' || !Number.isSafeInteger(receipt[key]) || receipt[key] < 0) {
      throw new ProtocolContractError('malformed dsh-gate token budget state receipt')
    }
  }
  const bucketTotal = Number(receipt.uncachedInputTokens) + Number(receipt.outputTokens)
    + Number(receipt.cacheReadTokens) + Number(receipt.cacheWriteTokens)
  if (receipt.usedTokens !== bucketTotal
    || receipt.remainingTokens !== Math.max(0, Number(receipt.limitTokens) - bucketTotal)
    || receipt.exhausted !== (bucketTotal >= Number(receipt.limitTokens))) {
    throw new ProtocolContractError('inconsistent dsh-gate token budget state receipt')
  }
  return receipt as unknown as TokenBudgetStateReceipt
}

async function postTokenBudgetState(
  baseUrl: string,
  request: TokenBudgetStateRequest,
): Promise<TokenBudgetStateReceipt> {
  const rpcId = `dsh-gate-budget-${request.runId}`
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/dsh-gate.budget-state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'dsh-gate.budget-state', payload: request }),
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) {
    throw new ProtocolContractError('DSH Host does not expose run-tree token budget state; reinstall the supervisor plugin and restart the Host')
  }
  if (!response.ok) throw new Error(`dsh-gate token budget carrier returned HTTP ${String(response.status)}`)
  const envelope = await response.json() as Record<string, unknown>
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId
    || typeof envelope.result !== 'object' || envelope.result === null) {
    throw new ProtocolContractError('malformed dsh-gate token budget state response')
  }
  const result = envelope.result as Record<string, unknown>
  if (result.ok === false) {
    const error = typeof result.error === 'object' && result.error !== null
      ? result.error as Record<string, unknown>
      : {}
    throw new Error(`${String(error.code ?? 'INTERNAL')}: ${String(error.message ?? 'token budget state failed')}`)
  }
  if (result.ok !== true) throw new ProtocolContractError('malformed dsh-gate token budget state result')
  return tokenBudgetStateReceipt(result.value, request)
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

function bounded(value: string, limit: number): string {
  return value.slice(0, limit)
}

function boundedTelemetry(values: Record<string, unknown> | undefined): CachedSessionMetadata['telemetry'] | undefined {
  if (values === undefined) return undefined
  const tokenUsage = telemetryTokenUsageSchema.safeParse(values.tokenUsage)
  const sessionStats = telemetrySessionStatsSchema.safeParse(values.sessionStats)
  const rawSubagent = typeof values.subagent === 'object' && values.subagent !== null
    && typeof (values.subagent as Record<string, unknown>).label === 'string'
    ? { ...(values.subagent as Record<string, unknown>), label: bounded((values.subagent as { label: string }).label, 256) }
    : values.subagent
  const subagent = telemetrySubagentSchema.safeParse(rawSubagent)
  return {
    asOfSeq: -1,
    ...tokenUsage.success ? { tokenUsage: tokenUsage.data } : {},
    ...sessionStats.success ? { sessionStats: sessionStats.data } : {},
    ...subagent.success ? { subagent: subagent.data } : {},
  }
}

/** Keep worker-authored question payloads from becoming an unbounded MCP response. */
export function boundedPendingQuestion(rpcId: string, values: readonly unknown[]): PendingQuestion {
  let truncated = values.length > QUESTION_COUNT_LIMIT || rpcId.length > INTERACTION_ID_LIMIT
  const questions = values.slice(0, QUESTION_COUNT_LIMIT).flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      truncated = true
      return []
    }
    const value = raw as Record<string, unknown>
    if (typeof value.id !== 'string' || typeof value.question !== 'string') {
      truncated = true
      return []
    }
    const options = Array.isArray(value.options)
      ? value.options.slice(0, QUESTION_OPTIONS_LIMIT).flatMap((rawOption) => {
          if (typeof rawOption !== 'object' || rawOption === null || Array.isArray(rawOption)
            || typeof (rawOption as Record<string, unknown>).label !== 'string') {
            truncated = true
            return []
          }
          const option = rawOption as Record<string, unknown>
          const label = option.label as string
          const description = typeof option.description === 'string' ? option.description : undefined
          if ('description' in option && description === undefined) truncated = true
          if (label.length > QUESTION_OPTION_LABEL_LIMIT
            || (description?.length ?? 0) > QUESTION_OPTION_DESCRIPTION_LIMIT) truncated = true
          return [{
            label: bounded(label, QUESTION_OPTION_LABEL_LIMIT),
            ...description === undefined ? {} : {
              description: bounded(description, QUESTION_OPTION_DESCRIPTION_LIMIT),
            },
          }]
        })
      : undefined
    if ('options' in value && !Array.isArray(value.options)) truncated = true
    if (Array.isArray(value.options) && value.options.length > QUESTION_OPTIONS_LIMIT) truncated = true
    const detail = typeof value.detail === 'string' ? value.detail : undefined
    const header = typeof value.header === 'string' ? value.header : undefined
    const rawIntentApprove = typeof value.intent === 'object' && value.intent !== null
      && (value.intent as Record<string, unknown>).kind === 'plan-review'
      && typeof (value.intent as Record<string, unknown>).approve === 'string'
      ? (value.intent as { approve: string }).approve
      : undefined
    const intent = rawIntentApprove === undefined
      ? undefined
      : { kind: 'plan-review' as const, approve: bounded(rawIntentApprove, QUESTION_OPTION_LABEL_LIMIT) }
    if ('detail' in value && detail === undefined) truncated = true
    if ('header' in value && header === undefined) truncated = true
    if ('multiSelect' in value && typeof value.multiSelect !== 'boolean') truncated = true
    if ('intent' in value && rawIntentApprove === undefined) truncated = true
    if ((value.id as string).length > QUESTION_ID_LIMIT
      || (value.question as string).length > QUESTION_TEXT_LIMIT
      || (detail?.length ?? 0) > QUESTION_DETAIL_LIMIT
      || (header?.length ?? 0) > QUESTION_HEADER_LIMIT
      || (rawIntentApprove?.length ?? 0) > QUESTION_OPTION_LABEL_LIMIT) truncated = true
    return [{
      id: bounded(value.id as string, QUESTION_ID_LIMIT),
      question: bounded(value.question as string, QUESTION_TEXT_LIMIT),
      ...detail === undefined ? {} : { detail: bounded(detail, QUESTION_DETAIL_LIMIT) },
      ...header === undefined ? {} : { header: bounded(header, QUESTION_HEADER_LIMIT) },
      ...options === undefined ? {} : { options },
      ...typeof value.multiSelect === 'boolean' ? { multiSelect: value.multiSelect } : {},
      ...intent === undefined ? {} : { intent },
    }]
  })
  return {
    rpcId: bounded(rpcId, INTERACTION_ID_LIMIT),
    questions,
    ...truncated ? { truncated: true as const, answerInWeb: true as const } : {},
  }
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
  private readonly sessionListeners = new Map<string, Set<() => void>>()
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
    private readonly budgetStateTransport: TokenBudgetStateTransport = request => postTokenBudgetState(baseUrl, request),
    private readonly recoveryTransport: RecoveryCapsuleTransport = request => postRecoveryCapsule(baseUrl, request),
  ) {
    this.controller = new ConnectionController(this.api, {
      onConnected: (description) => {
        this.description = description
        this.protocolError = description.protocolVersion === 1
          ? undefined
          : `unsupported DSH Host protocol version ${String(description.protocolVersion)} (expected 1)`
        this.publishAll()
      },
      onStateChange: (state) => {
        if (state === 'reconnecting') this.description = undefined
        this.publishAll()
      },
      onMuxEnvelope: envelope => this.onMux(envelope),
      onHostEnvelope: envelope => this.onHost(envelope),
    })
    this.controller.start()
  }

  stopClient(): void {
    this.controller.stop()
  }

  private publishAll(): void {
    for (const listener of [...this.listeners]) listener()
    for (const listeners of this.sessionListeners.values()) {
      for (const listener of [...listeners]) listener()
    }
  }

  private publishSession(sessionId: string): void {
    for (const listener of [...this.listeners]) listener()
    for (const listener of [...(this.sessionListeners.get(sessionId) ?? [])]) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private subscribeSession(sessionId: string, listener: () => void): () => void {
    const listeners = this.sessionListeners.get(sessionId) ?? new Set<() => void>()
    listeners.add(listener)
    this.sessionListeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.sessionListeners.delete(sessionId)
    }
  }

  private onMux(envelope: RpcRequest<MuxFrame>): void {
    const frame = envelope.payload
    if (frame.type === 'session/event') {
      const sessionEvents = this.events.get(frame.sessionId) ?? new Map<number, DshEvent>()
      sessionEvents.set(frame.event.seq, frame.event as DshEvent)
      this.events.set(frame.sessionId, sessionEvents)
    } else if (frame.type === 'approval/requested') {
      const answerInWeb = envelope.rpcId.length > INTERACTION_ID_LIMIT
        || frame.approvalId.length > INTERACTION_ID_LIMIT
        || frame.toolName.length > APPROVAL_TOOL_NAME_LIMIT
        || (frame.callId?.length ?? 0) > INTERACTION_ID_LIMIT
        || (frame.reason?.length ?? 0) > APPROVAL_REASON_LIMIT
      this.approvals.set(frame.sessionId, {
        rpcId: bounded(envelope.rpcId, INTERACTION_ID_LIMIT),
        approvalId: bounded(frame.approvalId, INTERACTION_ID_LIMIT),
        toolName: bounded(frame.toolName, APPROVAL_TOOL_NAME_LIMIT),
        ...frame.callId === undefined ? {} : { callId: bounded(frame.callId, INTERACTION_ID_LIMIT) },
        ...frame.reason === undefined ? {} : { reason: bounded(frame.reason, APPROVAL_REASON_LIMIT) },
        ...answerInWeb ? { truncated: true as const, answerInWeb: true as const } : {},
      })
    } else if (frame.type === 'approval/resolved') {
      this.approvals.delete(frame.sessionId)
    } else if (frame.type === 'question/requested') {
      this.questions.set(frame.sessionId, boundedPendingQuestion(envelope.rpcId, frame.questions))
    } else if (frame.type === 'question/resolved') {
      this.questions.delete(frame.sessionId)
    }
    if ('sessionId' in frame) this.publishSession(frame.sessionId)
    else this.publishAll()
  }

  private onHost(envelope: RpcRequest<HostFrame>): void {
    const frame = envelope.payload
    if (frame.type === 'host/session-status') {
      this.running.set(frame.sessionId, frame.running)
      // The Host observing the agent running again is the authoritative recovery
      // signal for a previously reported agent error; an idle session keeps it.
      if (frame.running) this.hostErrors.delete(frame.sessionId)
    } else if (frame.type === 'host/agent-error') {
      this.hostErrors.set(frame.sessionId, bounded(frame.message, FAILURE_MESSAGE_LIMIT))
    } else if (frame.type === 'host/session-removed') {
      this.dropSession(frame.sessionId)
    }
    if ('sessionId' in frame) this.publishSession(frame.sessionId)
    else this.publishAll()
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
    if (this.protocolError !== undefined) throw new ProtocolContractError(this.protocolError)
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
          reject(new ProtocolContractError(this.protocolError))
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

  /** Read the Host's exact durable recovery capsule for one interrupted run tree. */
  recoveryCapsule(request: RecoveryCapsuleRequest): Promise<RecoveryCapsule> {
    return this.recoveryTransport(request)
  }

  /** Read the Host's durable run-tree token projection without invoking a model. */
  tokenBudgetState(request: TokenBudgetStateRequest): Promise<TokenBudgetStateReceipt> {
    return this.budgetStateTransport(request)
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
        maxMessages: 200,
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
    const boundedProjection = boundedTelemetry(telemetryValues)
    const telemetry = projections === undefined || boundedProjection === undefined ? undefined : {
      ...boundedProjection,
      asOfSeq: projections.asOfSeq,
    }
    this.metadata.set(sessionId, {
      ...row.cwd === undefined ? {} : { cwd: row.cwd },
      ...row.agentPreset === undefined ? {} : { agentPreset: row.agentPreset },
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
      ...row.agentPreset === undefined ? {} : { agentPreset: row.agentPreset },
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
      ...metadata.agentPreset === undefined ? {} : { agentPreset: metadata.agentPreset },
    }
  }

  waitForChange(timeoutMs: number): Promise<boolean>
  waitForChange(sessionId: string, timeoutMs: number): Promise<boolean>
  waitForChange(sessionIdOrTimeout: string | number, timeoutMs?: number): Promise<boolean> {
    const sessionId = typeof sessionIdOrTimeout === 'string' ? sessionIdOrTimeout : undefined
    const waitMs = typeof sessionIdOrTimeout === 'number' ? sessionIdOrTimeout : timeoutMs as number
    return new Promise(resolve => {
      const timer = setTimeout(() => { dispose(); resolve(false) }, waitMs)
      const listener = () => { clearTimeout(timer); dispose(); resolve(true) }
      const dispose = sessionId === undefined ? this.subscribe(listener) : this.subscribeSession(sessionId, listener)
    })
  }

  async answerApproval(sessionId: string, rpcId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const pending = this.approvals.get(sessionId)
    if (pending === undefined) throw new Error(`no pending approval for ${sessionId}`)
    if (pending.rpcId !== rpcId) throw new Error(`stale approval rpcId ${rpcId}; active rpcId is ${pending.rpcId}`)
    if (pending.answerInWeb === true) {
      throw new Error('pending approval exceeded the bounded supervisor envelope; answer it in DSH Web')
    }
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
    if (pending.answerInWeb === true) {
      throw new Error('pending question exceeded the bounded supervisor envelope; answer it in DSH Web')
    }
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
