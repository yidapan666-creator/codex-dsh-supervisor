/** Host-owned atomic admission for one supervised DSH task. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  affiliatedChildActivation,
  buildRecoveryCapsule,
  type RecoveryCapsule,
  type RecoveryEvent,
  type RecoveryScope,
  type RecoveryTaskPacket,
} from './recovery.js'

export const TASK_ADMISSION_PATH = '/api/dsh-gate.admit'
export const RECOVERY_CAPSULE_PATH = '/api/dsh-gate.recovery-capsule'
const TASK_PACKET_START = '<dsh-supervised-task>'
const TASK_PACKET_END = '</dsh-supervised-task>'
const MAX_ADMISSION_BODY_BYTES = 512 * 1024
const ADMISSION_ID_LIMIT = 512
const MODEL_SELECTION_LIMIT = 256
const REASONING_EFFORT_LIMIT = 64
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
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

export type TaskAdmissionErrorCode =
  | 'BAD_REQUEST'
  | 'SESSION_NOT_ATTACHED'
  | 'SESSION_BUSY'
  | 'WRITER_CONFLICT'
  | 'REQUEST_ID_CONFLICT'
  | 'ADMISSION_CORRUPT'
  | 'PROMPT_REJECTED'
  | 'DURABILITY_UNAVAILABLE'
  | 'INTERNAL'

export class TaskAdmissionError extends Error {
  constructor(readonly code: TaskAdmissionErrorCode, message: string) {
    super(message)
    this.name = 'TaskAdmissionError'
  }
}

interface AdmissionMessage {
  id?: string
  content?: unknown
}

interface AdmissionEvent {
  type: string
  seq: number
  time?: number
  data: unknown
}

interface AdmissionSession {
  header: { id: string; cwd?: string; parentSession?: string; seedLength?: number; createdAt?: number }
  events: readonly AdmissionEvent[]
  append?(type: string, data: unknown): AdmissionEvent
}

interface AdmissionAgent {
  status: 'idle' | 'running'
  session: AdmissionSession
  inbox: {
    nextTurn: readonly AdmissionMessage[]
    nextStep: readonly AdmissionMessage[]
    remove(messageId: string): boolean
  }
  followup(message: AdmissionMessage): void
}

export interface TaskAdmissionRuntime {
  agents: { list(): AdmissionAgent[] }
  sessions: { flush(session: AdmissionSession): Promise<boolean> }
  sessionPersistence: {
    listSnapshots(): Promise<Array<{
      header: AdmissionSession['header']
      revision: string
    }>>
    inspect(id: string): Promise<{
      meta: AdmissionSession['header']
      events: readonly AdmissionEvent[]
    }>
  }
  apiProxy: {
    sessions: {
      /** Native Host resolver: reading models resumes a cold ordinary session without a model call. */
      models?(request: {
        rpcId: string
        payload: { sessionId: string }
      }): Promise<{
        result: { ok: true; value: unknown }
          | { ok: false; error: { code: string; message: string } }
      }>
      prompt(request: {
        rpcId: string
        payload: {
          sessionId: string
          mode: 'queue'
          content: Array<{ type: 'text'; text: string }>
        }
      }): Promise<{
        result: { ok: true; value: { accepted: true } }
          | { ok: false; error: { code: string; message: string } }
      }>
      selectModel(request: {
        rpcId: string
        payload: {
          sessionId: string
          provider: string
          model: string
          reasoningEffort?: string
        }
      }): Promise<{
        result: { ok: true; value: unknown }
          | { ok: false; error: { code: string; message: string } }
      }>
    }
  }
}

interface PacketIdentity {
  message?: AdmissionMessage
  sessionId: string
  requestId?: string
  requestDigest?: string
  runId: string
  writerMode: 'writer' | 'read_only'
  seq: number
  packet: Record<string, unknown>
}

type ValidatedTaskAdmissionRequest = TaskAdmissionRequest & {
  writerMode: 'writer' | 'read_only'
  packet: Record<string, unknown>
}

/** Resolve the nearest Git worktree root, or the exact canonical cwd outside Git. */
export async function resolveAdmissionWriterDomain(cwd: string): Promise<string> {
  const resolved = await realpath(cwd)
  let candidate = resolved
  while (true) {
    try {
      await lstat(join(candidate, '.git'))
      return candidate
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return resolved
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const candidate = block as { type?: unknown; text?: unknown; content?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') return [candidate.text]
    if (candidate.type === 'tool-result') return [contentText(candidate.content)]
    return []
  }).join('\n')
}

function eventMessages(event: AdmissionEvent): AdmissionMessage[] {
  if (event.type === 'user/message') {
    const data = event.data as AdmissionMessage & { message?: AdmissionMessage }
    return [data.message ?? data]
  }
  if (event.type !== 'agent/inbox/spliced') return []
  const inserted = (event.data as { inserted?: unknown }).inserted
  return Array.isArray(inserted)
    ? inserted.filter((value): value is AdmissionMessage => typeof value === 'object' && value !== null)
    : []
}

function packetIdentities(events: readonly AdmissionEvent[]): PacketIdentity[] {
  const identities: PacketIdentity[] = []
  for (const event of events) {
    for (const message of eventMessages(event)) {
      const text = contentText(message.content)
      let before = text.length
      while (before >= 0) {
        const end = text.lastIndexOf(TASK_PACKET_END, before)
        if (end < 0) break
        const start = text.lastIndexOf(TASK_PACKET_START, end)
        if (start < 0) break
        try {
          const value = JSON.parse(text.slice(start + TASK_PACKET_START.length, end).trim()) as Record<string, unknown>
          if (value.schemaVersion === 2
            && typeof value.sessionId === 'string' && value.sessionId.length > 0
            && typeof value.runId === 'string' && UUID_PATTERN.test(value.runId)) {
            identities.push({
              message,
              sessionId: value.sessionId,
              ...typeof value.requestId === 'string' && UUID_PATTERN.test(value.requestId)
                ? { requestId: value.requestId }
                : {},
              ...typeof value.requestDigest === 'string' && DIGEST_PATTERN.test(value.requestDigest)
                ? { requestDigest: value.requestDigest }
                : {},
              runId: value.runId,
              // Schema-v2 packets require writerMode. Treat malformed/older
              // packets as writers so admission fails closed.
              writerMode: value.writerMode === 'read_only' ? 'read_only' : 'writer',
              seq: event.seq,
              packet: value,
            })
          }
        } catch { /* Marker-like prose is not an admission packet. */ }
        before = start - 1
      }
    }
  }
  return identities
}

function validateRequest(value: unknown): ValidatedTaskAdmissionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskAdmissionError('BAD_REQUEST', 'admission payload must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== 1
    || typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0
    || candidate.sessionId.length > ADMISSION_ID_LIMIT
    || typeof candidate.requestId !== 'string' || !UUID_PATTERN.test(candidate.requestId)
    || typeof candidate.requestDigest !== 'string' || !DIGEST_PATTERN.test(candidate.requestDigest)
    || typeof candidate.runId !== 'string' || !UUID_PATTERN.test(candidate.runId)
    || typeof candidate.prompt !== 'string' || candidate.prompt.length === 0
    || typeof candidate.modelSelection !== 'object' || candidate.modelSelection === null
    || typeof (candidate.modelSelection as Record<string, unknown>).provider !== 'string'
    || ((candidate.modelSelection as Record<string, unknown>).provider as string).length === 0
    || ((candidate.modelSelection as Record<string, unknown>).provider as string).length > MODEL_SELECTION_LIMIT
    || typeof (candidate.modelSelection as Record<string, unknown>).model !== 'string'
    || ((candidate.modelSelection as Record<string, unknown>).model as string).length === 0
    || ((candidate.modelSelection as Record<string, unknown>).model as string).length > MODEL_SELECTION_LIMIT
    || ((candidate.modelSelection as Record<string, unknown>).reasoningEffort !== undefined
      && (typeof (candidate.modelSelection as Record<string, unknown>).reasoningEffort !== 'string'
        || ((candidate.modelSelection as Record<string, unknown>).reasoningEffort as string).length > REASONING_EFFORT_LIMIT))) {
    throw new TaskAdmissionError('BAD_REQUEST', 'invalid task admission payload')
  }
  if (Buffer.byteLength(candidate.prompt, 'utf8') > MAX_ADMISSION_BODY_BYTES) {
    throw new TaskAdmissionError('BAD_REQUEST', 'task admission prompt is too large')
  }
  const embedded = packetIdentities([{
    type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: candidate.prompt }] },
  }]).find(identity => identity.requestId === candidate.requestId)
  if (embedded === undefined
    || embedded.sessionId !== candidate.sessionId
    || embedded.requestDigest !== candidate.requestDigest
    || embedded.runId !== candidate.runId) {
    throw new TaskAdmissionError('BAD_REQUEST', 'outer admission identity does not match the embedded task packet')
  }
  const embeddedParent = embedded.packet.parentRunId
  const embeddedCapsule = embedded.packet.recoveryCapsule
  if ((candidate.parentRunId !== undefined && typeof candidate.parentRunId !== 'string')
    || (candidate.recoveryCapsule !== undefined
      && (typeof candidate.recoveryCapsule !== 'object' || candidate.recoveryCapsule === null))) {
    throw new TaskAdmissionError('BAD_REQUEST', 'invalid outer recovery continuation')
  }
  if (canonicalJson(candidate.parentRunId) !== canonicalJson(embeddedParent)
    || canonicalJson(candidate.recoveryCapsule) !== canonicalJson(embeddedCapsule)) {
    throw new TaskAdmissionError('BAD_REQUEST', 'outer recovery continuation does not match the embedded task packet')
  }
  if ((embeddedParent === undefined) !== (embeddedCapsule === undefined)) {
    throw new TaskAdmissionError('BAD_REQUEST', 'parentRunId and recoveryCapsule must be supplied together')
  }
  return {
    ...(candidate as unknown as TaskAdmissionRequest),
    writerMode: embedded.writerMode,
    packet: embedded.packet,
  }
}

interface DurableAdmissionSession {
  header: AdmissionSession['header']
  events: readonly AdmissionEvent[]
  status: 'idle' | 'running'
  pending: boolean
  resident?: AdmissionAgent
}

/** Adapted from DSH's MIT-licensed Inbox replay: durable splice events are the pending-work store. */
function pendingInbox(events: readonly AdmissionEvent[], seedLength = 0): boolean {
  const state: Record<'next-turn' | 'next-step', unknown[]> = { 'next-turn': [], 'next-step': [] }
  for (const event of events.slice(seedLength)) {
    if (event.type !== 'agent/inbox/spliced') continue
    const splice = event.data as { target?: unknown; start?: unknown; removedCount?: unknown; inserted?: unknown }
    if ((splice.target !== 'next-turn' && splice.target !== 'next-step')
      || !Number.isSafeInteger(splice.start) || Number(splice.start) < 0
      || (splice.removedCount !== undefined && (!Number.isSafeInteger(splice.removedCount) || Number(splice.removedCount) < 0))
      || !Array.isArray(splice.inserted)) {
      throw new TaskAdmissionError('ADMISSION_CORRUPT', `invalid persisted inbox splice at seq ${String(event.seq)}`)
    }
    const inbox = state[splice.target]
    const start = Number(splice.start)
    const removed = Number(splice.removedCount ?? 0)
    if (start > inbox.length || start + removed > inbox.length) {
      throw new TaskAdmissionError('ADMISSION_CORRUPT', `out-of-range persisted inbox splice at seq ${String(event.seq)}`)
    }
    inbox.splice(start, removed, ...splice.inserted)
  }
  return state['next-turn'].length > 0 || state['next-step'].length > 0
}

function interruptedTurnEnd(events: readonly AdmissionEvent[], afterSeq: number): AdmissionEvent | undefined {
  const latestBoundary = events.findLast(event => event.seq > afterSeq
    && (event.type === 'turn/start' || event.type === 'turn/end'))
  if (latestBoundary?.type !== 'turn/end') return undefined
  const reason = (latestBoundary.data as { reason?: { kind?: unknown } }).reason?.kind
  return reason === 'interrupted' ? latestBoundary : undefined
}

function recoveryPacket(value: Record<string, unknown>): RecoveryTaskPacket {
  const baseline = value.baseline
  const budget = value.budget
  if (value.schemaVersion !== 2 || typeof value.sessionId !== 'string'
    || typeof value.runId !== 'string' || typeof value.objective !== 'string'
    || (baseline !== undefined && (typeof baseline !== 'object' || baseline === null
      || typeof (baseline as Record<string, unknown>).statusSummary !== 'string'))
    || (budget !== undefined && (typeof budget !== 'object' || budget === null
      || typeof (budget as Record<string, unknown>).maxTokens !== 'number'))) {
    throw new TaskAdmissionError('BAD_REQUEST', 'continuation packet is malformed')
  }
  return value as unknown as RecoveryTaskPacket
}

export class HostRecoveryCoordinator {
  constructor(private readonly runtime: TaskAdmissionRuntime) {}

  private async durableSessions(): Promise<Map<string, DurableAdmissionSession>> {
    let snapshots: Awaited<ReturnType<TaskAdmissionRuntime['sessionPersistence']['listSnapshots']>>
    try {
      snapshots = await this.runtime.sessionPersistence.listSnapshots()
    } catch (error) {
      throw new TaskAdmissionError(
        'DURABILITY_UNAVAILABLE',
        `could not enumerate durable sessions: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const live = new Map(this.runtime.agents.list().map(agent => [agent.session.header.id, agent]))
    const sessions = new Map<string, DurableAdmissionSession>()
    for (const snapshot of snapshots) {
      const resident = live.get(snapshot.header.id)
      let inspected: { meta: AdmissionSession['header']; events: readonly AdmissionEvent[] }
      try {
        inspected = resident === undefined
          ? await this.runtime.sessionPersistence.inspect(snapshot.header.id)
          : { meta: resident.session.header, events: resident.session.events }
      } catch (error) {
        throw new TaskAdmissionError(
          'DURABILITY_UNAVAILABLE',
          `could not inspect durable session ${snapshot.header.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      sessions.set(snapshot.header.id, {
        header: inspected.meta,
        events: inspected.events,
        status: resident?.status ?? 'idle',
        pending: resident === undefined
          ? pendingInbox(inspected.events, inspected.meta.seedLength)
          : resident.inbox.nextTurn.length > 0 || resident.inbox.nextStep.length > 0,
        ...resident === undefined ? {} : { resident },
      })
    }
    for (const resident of live.values()) {
      if (sessions.has(resident.session.header.id)) continue
      sessions.set(resident.session.header.id, {
        header: resident.session.header,
        events: resident.session.events,
        status: resident.status,
        pending: resident.inbox.nextTurn.length > 0 || resident.inbox.nextStep.length > 0,
        resident,
      })
    }
    return sessions
  }

  async snapshot(): Promise<Map<string, DurableAdmissionSession>> {
    return this.durableSessions()
  }

  async capsule(sessionId: string, parentRunId: string): Promise<RecoveryCapsule> {
    const sessions = await this.durableSessions()
    const root = sessions.get(sessionId)
    if (root === undefined) throw new TaskAdmissionError('BAD_REQUEST', `recovery session ${sessionId} does not exist`)
    const identity = packetIdentities(root.events).at(-1)
    if (identity === undefined || identity.sessionId !== sessionId || identity.runId !== parentRunId) {
      throw new TaskAdmissionError('BAD_REQUEST', `parent run ${parentRunId} is not the current durable run for session ${sessionId}`)
    }
    const terminal = interruptedTurnEnd(root.events, identity.seq)
    if (terminal === undefined) {
      throw new TaskAdmissionError('BAD_REQUEST', `parent run ${parentRunId} is not durably interrupted`)
    }
    if (root.status === 'running' || root.pending) {
      throw new TaskAdmissionError('SESSION_BUSY', `parent run ${parentRunId} still has active or pending Root work`)
    }
    const packet = recoveryPacket(identity.packet)
    const boundary = root.events.find(event => event.seq === identity.seq)
    if (boundary?.time === undefined) {
      throw new TaskAdmissionError('ADMISSION_CORRUPT', `parent run ${parentRunId} has no durable packet time`)
    }
    const headers = new Map([...sessions].map(([id, session]) => [id, session.header]))
    const isDescendant = (candidateId: string): boolean => {
      let current = headers.get(candidateId)
      const seen = new Set<string>()
      while (current?.parentSession !== undefined) {
        if (seen.has(current.id)) throw new TaskAdmissionError('ADMISSION_CORRUPT', 'session lineage contains a cycle')
        seen.add(current.id)
        if (current.parentSession === sessionId) return true
        current = headers.get(current.parentSession)
      }
      return false
    }
    const scopes: RecoveryScope[] = [{
      sessionId,
      events: root.events as readonly RecoveryEvent[],
      activationSeq: identity.seq,
      terminalSeq: terminal.seq,
      ...root.header.cwd === undefined ? {} : { cwd: root.header.cwd },
    }]
    for (const [candidateId, candidate] of sessions) {
      if (!isDescendant(candidateId)) continue
      const activation = affiliatedChildActivation(
        candidate.events as readonly RecoveryEvent[], candidateId, boundary.time, parentRunId,
      )
      if (activation === undefined) continue
      const latestStart = candidate.events.findLast(event => event.type === 'turn/start' && event.seq > activation.seq)
      const childTerminal = candidate.events.findLast(event => event.type === 'turn/end' && event.seq > activation.seq)
      if (candidate.status === 'running' || candidate.pending || childTerminal === undefined
        || (latestStart !== undefined && latestStart.seq > childTerminal.seq)) {
        throw new TaskAdmissionError('SESSION_BUSY', `affiliated child ${candidateId} is active, pending, or terminally unverified`)
      }
      const candidateCwd = candidate.header.cwd ?? root.header.cwd
      scopes.push({
        sessionId: candidateId,
        events: candidate.events as readonly RecoveryEvent[],
        activationSeq: activation.seq,
        terminalSeq: childTerminal.seq,
        ...candidateCwd === undefined ? {} : { cwd: candidateCwd },
      })
    }
    return buildRecoveryCapsule(packet, scopes, terminal.seq)
  }
}

/** Serializes admissions per durable session and commits the inbox insertion before returning. */
export class TaskAdmissionCoordinator {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly recovery: HostRecoveryCoordinator

  constructor(
    private readonly runtime: TaskAdmissionRuntime,
    private readonly resolveWriterDomain: (cwd: string) => Promise<string> = resolveAdmissionWriterDomain,
    recovery?: HostRecoveryCoordinator,
  ) {
    this.recovery = recovery ?? new HostRecoveryCoordinator(runtime)
  }

  async admit(input: unknown): Promise<TaskAdmissionReceipt> {
    const request = validateRequest(input)
    return this.exclusive(`session:${request.sessionId}`, async () => {
      const agent = await this.ensureAttached(request.sessionId, request.requestId)
      if (request.writerMode === 'read_only') return this.admitExclusive(request)
      const cwd = agent.session.header.cwd
      if (cwd === undefined) {
        throw new TaskAdmissionError('BAD_REQUEST', `writer session ${request.sessionId} has no authoritative cwd`)
      }
      const domain = await this.resolveWriterDomain(cwd)
      return this.exclusive(`writer:${domain}`, () => this.admitExclusive(request, domain))
    })
  }

  /** Reuse DSH's native cold-session resolver before admission needs live cwd/policy state. */
  private async ensureAttached(sessionId: string, requestId: string): Promise<AdmissionAgent> {
    const current = this.runtime.agents.list()
      .find(candidate => candidate.session.header.id === sessionId)
    if (current !== undefined) return current
    const models = this.runtime.apiProxy.sessions.models
    if (models === undefined) {
      throw new TaskAdmissionError(
        'SESSION_NOT_ATTACHED',
        `session ${sessionId} is not attached and the Host exposes no native cold-session resolver`,
      )
    }
    let resumed: Awaited<ReturnType<NonNullable<typeof models>>>
    try {
      resumed = await models({ rpcId: `${requestId}:resume`, payload: { sessionId } })
    } catch (error) {
      throw new TaskAdmissionError(
        'DURABILITY_UNAVAILABLE',
        `could not resume durable session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!resumed.result.ok) {
      throw new TaskAdmissionError(
        resumed.result.error.code === 'session-not-found' ? 'SESSION_NOT_ATTACHED' : 'DURABILITY_UNAVAILABLE',
        `${resumed.result.error.code}: ${resumed.result.error.message}`,
      )
    }
    const attached = this.runtime.agents.list()
      .find(candidate => candidate.session.header.id === sessionId)
    if (attached === undefined) {
      throw new TaskAdmissionError('INTERNAL', `native resume did not attach session ${sessionId}`)
    }
    return attached
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    this.tails.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  private async admitExclusive(
    request: ValidatedTaskAdmissionRequest,
    writerDomain?: string,
  ): Promise<TaskAdmissionReceipt> {
    const agent = this.runtime.agents.list().find(candidate => candidate.session.header.id === request.sessionId)
    if (agent === undefined) {
      throw new TaskAdmissionError(
        'SESSION_NOT_ATTACHED',
        `session ${request.sessionId} is not attached; resolve it through the Host API before admission`,
      )
    }
    const matches = packetIdentities(agent.session.events)
      .filter(identity => identity.sessionId === request.sessionId && identity.requestId === request.requestId)
    if (matches.length > 0) {
      if (matches.some(identity => identity.requestDigest !== request.requestDigest)) {
        throw new TaskAdmissionError(
          'REQUEST_ID_CONFLICT',
          `requestId ${request.requestId} was already used with a different task payload`,
        )
      }
      const runIds = new Set(matches.map(identity => identity.runId))
      if (runIds.size !== 1) {
        throw new TaskAdmissionError('ADMISSION_CORRUPT', `requestId ${request.requestId} has multiple durable run ids`)
      }
      await this.rearmPendingAfterRestart(agent, matches)
      return this.receipt(request, matches[0]?.runId as string, true, agent.session.events.at(-1)?.seq ?? -1)
    }
    if (request.parentRunId !== undefined && request.recoveryCapsule !== undefined) {
      const expected = await this.recovery.capsule(request.sessionId, request.parentRunId)
      if (canonicalJson(expected) !== canonicalJson(request.recoveryCapsule)) {
        throw new TaskAdmissionError(
          'BAD_REQUEST',
          `recoveryCapsule does not match Host durable evidence for parent run ${request.parentRunId}`,
        )
      }
    }
    const durable = await this.recovery.snapshot()
    const current = durable.get(request.sessionId)
    const currentIdentity = current === undefined ? undefined : packetIdentities(current.events).at(-1)
    const interrupted = currentIdentity === undefined || current === undefined
      ? undefined
      : interruptedTurnEnd(current.events, currentIdentity.seq)
    if (interrupted !== undefined && currentIdentity !== undefined && request.parentRunId === undefined) {
      throw new TaskAdmissionError(
        'BAD_REQUEST',
        `session ${request.sessionId} requires an exact continuation of interrupted run ${currentIdentity.runId}`,
      )
    }
    const unsettled = this.unsettledRunTree(request.sessionId, durable)
    if (unsettled !== undefined) {
      throw new TaskAdmissionError(
        'SESSION_BUSY',
        `session ${request.sessionId} still owns unfinished supervised work (${unsettled}); wait for the current run tree before dispatching another task`,
      )
    }
    if (writerDomain !== undefined) {
      const owner = await this.activeWriterOwner(
        writerDomain,
        durable,
        request.parentRunId === currentIdentity?.runId ? request.sessionId : undefined,
      )
      if (owner !== undefined) {
        throw new TaskAdmissionError(
          'WRITER_CONFLICT',
          `working tree already has writer session ${owner}; use read_only or an independent worktree`,
        )
      }
    }
    if (agent.status !== 'idle') {
      throw new TaskAdmissionError(
        'SESSION_BUSY',
        `session ${request.sessionId} is already running; wait for its current supervised run before dispatching another`,
      )
    }
    const selected = await this.runtime.apiProxy.sessions.selectModel({
      rpcId: `${request.requestId}:model`,
      payload: {
        sessionId: request.sessionId,
        provider: request.modelSelection.provider,
        model: request.modelSelection.model,
        ...request.modelSelection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.modelSelection.reasoningEffort },
      },
    })
    if (!selected.result.ok) {
      throw new TaskAdmissionError(
        'PROMPT_REJECTED',
        `${selected.result.error.code}: ${selected.result.error.message}`,
      )
    }
    if (agent.session.append === undefined) {
      throw new TaskAdmissionError('INTERNAL', 'session runtime does not expose durable sandbox policy events')
    }
    agent.session.append('sandbox/mode', {
      mode: request.writerMode === 'read_only' ? 'read-only' : 'workspace-write',
    })
    if (request.writerMode === 'read_only') {
      // A read-only worker must not turn a denied write into a one-shot
      // elevated write. Writer admission never broadens the deployment's
      // approval policy; a later user-controlled policy change stays explicit.
      agent.session.append('approval/policy', { policy: 'never' })
    }
    const response = await this.runtime.apiProxy.sessions.prompt({
      rpcId: request.requestId,
      payload: {
        sessionId: request.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: request.prompt }],
      },
    })
    if (!response.result.ok) {
      throw new TaskAdmissionError(
        'PROMPT_REJECTED',
        `${response.result.error.code}: ${response.result.error.message}`,
      )
    }
    const admittedAgent = this.runtime.agents.list()
      .find(candidate => candidate.session.header.id === request.sessionId)
    if (admittedAgent === undefined) {
      throw new TaskAdmissionError('INTERNAL', `session ${request.sessionId} detached during task admission`)
    }
    if (!await this.runtime.sessions.flush(admittedAgent.session)) {
      throw new TaskAdmissionError('DURABILITY_UNAVAILABLE', 'session persistence did not participate in admission flush')
    }
    const admitted = packetIdentities(admittedAgent.session.events)
      .find(identity => identity.requestId === request.requestId)
    if (admitted === undefined
      || admitted.requestDigest !== request.requestDigest
      || admitted.runId !== request.runId) {
      throw new TaskAdmissionError('INTERNAL', 'durable inbox does not contain the admitted task identity')
    }
    return this.receipt(request, admitted.runId, false, admittedAgent.session.events.at(-1)?.seq ?? admitted.seq)
  }

  private unsettledRunTree(
    rootSessionId: string,
    sessions: ReadonlyMap<string, DurableAdmissionSession>,
  ): string | undefined {
    const root = sessions.get(rootSessionId)
    if (root === undefined) return undefined
    const latest = packetIdentities(root.events).at(-1)
    if (latest === undefined) return undefined
    const headers = new Map([...sessions].map(([id, candidate]) => [id, candidate.header]))
    const isDescendant = (candidateId: string): boolean => {
      let current = headers.get(candidateId)
      const seen = new Set<string>()
      while (current?.parentSession !== undefined) {
        if (seen.has(current.id)) return false
        seen.add(current.id)
        if (current.parentSession === rootSessionId) return true
        current = headers.get(current.parentSession)
      }
      return false
    }
    const latestTurnBoundary = root.events.findLast(event => event.seq > latest.seq
      && (event.type === 'turn/start' || event.type === 'turn/end'))
    const rootEnded = latestTurnBoundary?.type === 'turn/end'
    if (!rootEnded) return 'root turn has not ended'
    if (root.pending) return 'root has a pending follow-up'
    const descendant = [...sessions].find(([id, candidate]) => isDescendant(id)
      && (candidate.status === 'running' || candidate.pending))
    return descendant === undefined ? undefined : `descendant ${descendant[0]} is active or has pending work`
  }

  private async activeWriterOwner(
    domain: string,
    sessions: ReadonlyMap<string, DurableAdmissionSession>,
    permittedInterruptedOwner?: string,
  ): Promise<string | undefined> {
    const headers = new Map([...sessions].map(([id, candidate]) => [id, candidate.header]))
    const isDescendant = (candidateId: string, rootId: string): boolean => {
      let current = headers.get(candidateId)
      const seen = new Set<string>()
      while (current?.parentSession !== undefined) {
        if (seen.has(current.id)) return false
        seen.add(current.id)
        if (current.parentSession === rootId) return true
        current = headers.get(current.parentSession)
      }
      return false
    }
    for (const candidate of sessions.values()) {
      const header = candidate.header
      if (header.parentSession !== undefined || header.cwd === undefined) continue
      const latest = packetIdentities(candidate.events).at(-1)
      if (latest?.writerMode !== 'writer') continue
      if (header.id === permittedInterruptedOwner) continue
      const latestTurnBoundary = candidate.events.findLast(event => event.seq > latest.seq
        && (event.type === 'turn/start' || event.type === 'turn/end'))
      const rootEnded = latestTurnBoundary?.type === 'turn/end'
      const rootInterrupted = rootEnded
        && (latestTurnBoundary.data as { reason?: { kind?: unknown } }).reason?.kind === 'interrupted'
      const descendantRunning = [...sessions].some(([id, session]) => isDescendant(id, header.id)
        && (session.status === 'running' || session.pending))
      const rootHasPendingWork = candidate.pending
      if (rootEnded && !rootInterrupted && !descendantRunning && !rootHasPendingWork) continue
      if (await this.resolveWriterDomain(header.cwd) === domain) return header.id
    }
    return undefined
  }

  private async rearmPendingAfterRestart(agent: AdmissionAgent, matches: readonly PacketIdentity[]): Promise<void> {
    if (agent.status !== 'idle') return
    const ids = new Set(matches.flatMap(match => match.message?.id === undefined ? [] : [match.message.id]))
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      .find(message => message.id !== undefined && ids.has(message.id))
    if (pending?.id === undefined) return
    if (!agent.inbox.remove(pending.id)) return
    agent.followup(pending)
    if (!await this.runtime.sessions.flush(agent.session)) {
      throw new TaskAdmissionError('DURABILITY_UNAVAILABLE', 'session persistence did not participate in recovery flush')
    }
  }

  private receipt(
    request: TaskAdmissionRequest,
    runId: string,
    reconciled: boolean,
    asOfSeq: number,
  ): TaskAdmissionReceipt {
    return {
      schemaVersion: 1,
      sessionId: request.sessionId,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      runId,
      reconciled,
      asOfSeq,
    }
  }
}

interface ClientRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: 'dsh-gate.admit'
  payload: unknown
}

interface RecoveryRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: 'dsh-gate.recovery-capsule'
  payload: { schemaVersion: 1; sessionId: string; parentRunId: string }
}

async function readEnvelope(req: IncomingMessage): Promise<ClientRequestEnvelope> {
  if (req.method !== 'POST') throw new TaskAdmissionError('BAD_REQUEST', 'task admission requires POST')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_ADMISSION_BODY_BYTES) throw new TaskAdmissionError('BAD_REQUEST', 'task admission body is too large')
    chunks.push(buffer)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw new TaskAdmissionError('BAD_REQUEST', 'task admission body is not valid JSON')
  }
  if (typeof value !== 'object' || value === null) throw new TaskAdmissionError('BAD_REQUEST', 'invalid request envelope')
  const envelope = value as Record<string, unknown>
  if (envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string'
    || envelope.rpcId.length === 0 || envelope.rpcId.length > ADMISSION_ID_LIMIT
    || envelope.method !== 'dsh-gate.admit') {
    throw new TaskAdmissionError('BAD_REQUEST', 'invalid task admission request envelope')
  }
  return envelope as unknown as ClientRequestEnvelope
}

async function readRecoveryEnvelope(req: IncomingMessage): Promise<RecoveryRequestEnvelope> {
  if (req.method !== 'POST') throw new TaskAdmissionError('BAD_REQUEST', 'recovery capsule requires POST')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_ADMISSION_BODY_BYTES) throw new TaskAdmissionError('BAD_REQUEST', 'recovery request is too large')
    chunks.push(buffer)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw new TaskAdmissionError('BAD_REQUEST', 'recovery request is not valid JSON')
  }
  if (typeof value !== 'object' || value === null) throw new TaskAdmissionError('BAD_REQUEST', 'invalid recovery envelope')
  const envelope = value as Record<string, unknown>
  const payload = envelope.payload
  if (envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string'
    || envelope.rpcId.length === 0 || envelope.rpcId.length > ADMISSION_ID_LIMIT
    || envelope.method !== 'dsh-gate.recovery-capsule'
    || typeof payload !== 'object' || payload === null
    || (payload as Record<string, unknown>).schemaVersion !== 1
    || typeof (payload as Record<string, unknown>).sessionId !== 'string'
    || ((payload as Record<string, unknown>).sessionId as string).length === 0
    || ((payload as Record<string, unknown>).sessionId as string).length > ADMISSION_ID_LIMIT
    || typeof (payload as Record<string, unknown>).parentRunId !== 'string'
    || !UUID_PATTERN.test((payload as Record<string, unknown>).parentRunId as string)) {
    throw new TaskAdmissionError('BAD_REQUEST', 'invalid recovery request envelope')
  }
  return envelope as unknown as RecoveryRequestEnvelope
}

function send(res: ServerResponse, rpcId: string, result: unknown): void {
  if (res.destroyed) return
  const body = JSON.stringify({ type: 'server-response', rpcId, result })
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Register the Host-local HTTP admission route on DSH's existing Web server. */
export function registerTaskAdmissionRoute(
  webServer: { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void },
  coordinator: TaskAdmissionCoordinator,
): () => void {
  return webServer.register({
    kind: 'exact',
    path: TASK_ADMISSION_PATH,
    handler: async (req, res) => {
      let rpcId = 'invalid'
      try {
        const envelope = await readEnvelope(req)
        rpcId = envelope.rpcId
        const value = await coordinator.admit(envelope.payload)
        send(res, rpcId, { ok: true, value })
      } catch (error: unknown) {
        const admitted = error instanceof TaskAdmissionError
          ? error
          : new TaskAdmissionError('INTERNAL', error instanceof Error ? error.message : String(error))
        send(res, rpcId, { ok: false, error: { code: admitted.code, message: admitted.message } })
      }
    },
  })
}

/** Host-owned recovery projection used by wait/recover and rechecked atomically by admission. */
export function registerRecoveryCapsuleRoute(
  webServer: { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void },
  coordinator: HostRecoveryCoordinator,
): () => void {
  return webServer.register({
    kind: 'exact',
    path: RECOVERY_CAPSULE_PATH,
    handler: async (req, res) => {
      let rpcId = 'invalid'
      try {
        const envelope = await readRecoveryEnvelope(req)
        rpcId = envelope.rpcId
        const value = await coordinator.capsule(envelope.payload.sessionId, envelope.payload.parentRunId)
        send(res, rpcId, { ok: true, value })
      } catch (error: unknown) {
        const admitted = error instanceof TaskAdmissionError
          ? error
          : new TaskAdmissionError('INTERNAL', error instanceof Error ? error.message : String(error))
        send(res, rpcId, { ok: false, error: { code: admitted.code, message: admitted.message } })
      }
    },
  })
}
