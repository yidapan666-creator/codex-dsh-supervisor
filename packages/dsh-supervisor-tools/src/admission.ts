/** Host-owned atomic admission for one supervised DSH task. */
import type { IncomingMessage, ServerResponse } from 'node:http'

export const TASK_ADMISSION_PATH = '/api/dsh-gate.admit'
const TASK_PACKET_START = '<dsh-supervised-task>'
const TASK_PACKET_END = '</dsh-supervised-task>'
const MAX_ADMISSION_BODY_BYTES = 512 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

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

export type TaskAdmissionErrorCode =
  | 'BAD_REQUEST'
  | 'SESSION_NOT_ATTACHED'
  | 'SESSION_BUSY'
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
  data: unknown
}

interface AdmissionSession {
  header: { id: string }
  events: readonly AdmissionEvent[]
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
  apiProxy: {
    sessions: {
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
    }
  }
}

interface PacketIdentity {
  message?: AdmissionMessage
  sessionId: string
  requestId: string
  requestDigest: string
  runId: string
  seq: number
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
            && typeof value.requestId === 'string' && UUID_PATTERN.test(value.requestId)
            && typeof value.requestDigest === 'string' && DIGEST_PATTERN.test(value.requestDigest)
            && typeof value.runId === 'string' && UUID_PATTERN.test(value.runId)) {
            identities.push({
              message,
              sessionId: value.sessionId,
              requestId: value.requestId,
              requestDigest: value.requestDigest,
              runId: value.runId,
              seq: event.seq,
            })
          }
        } catch { /* Marker-like prose is not an admission packet. */ }
        before = start - 1
      }
    }
  }
  return identities
}

function validateRequest(value: unknown): TaskAdmissionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskAdmissionError('BAD_REQUEST', 'admission payload must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== 1
    || typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0
    || typeof candidate.requestId !== 'string' || !UUID_PATTERN.test(candidate.requestId)
    || typeof candidate.requestDigest !== 'string' || !DIGEST_PATTERN.test(candidate.requestDigest)
    || typeof candidate.runId !== 'string' || !UUID_PATTERN.test(candidate.runId)
    || typeof candidate.prompt !== 'string' || candidate.prompt.length === 0) {
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
  return candidate as unknown as TaskAdmissionRequest
}

/** Serializes admissions per durable session and commits the inbox insertion before returning. */
export class TaskAdmissionCoordinator {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly runtime: TaskAdmissionRuntime) {}

  async admit(input: unknown): Promise<TaskAdmissionReceipt> {
    const request = validateRequest(input)
    return this.exclusive(request.sessionId, () => this.admitExclusive(request))
  }

  private async exclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    this.tails.set(sessionId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
    }
  }

  private async admitExclusive(request: TaskAdmissionRequest): Promise<TaskAdmissionReceipt> {
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
    if (agent.status !== 'idle') {
      throw new TaskAdmissionError(
        'SESSION_BUSY',
        `session ${request.sessionId} is already running; wait for its current supervised run before dispatching another`,
      )
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
    || envelope.method !== 'dsh-gate.admit') {
    throw new TaskAdmissionError('BAD_REQUEST', 'invalid task admission request envelope')
  }
  return envelope as unknown as ClientRequestEnvelope
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
