import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-connection/client'
import { deriveObservation, parseTaskPacket, progressObservation, timeoutObservation } from './fold.js'
import {
  HostConnection, launchDetachedHost, parseLaunchConfig, type HostLaunchConfig,
} from './host.js'
import { TASK_PACKET_END, TASK_PACKET_START, type Observation, type TaskPacket } from './contracts.js'

function unwrap<T>(response: { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } } }): T {
  if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`)
  return response.result.value
}

function normalizedUrl(value: string): string {
  return new URL(value).origin
}

/**
 * Identity of one writer domain for a cwd. Different subdirectories of the same
 * Git worktree resolve to the same worktree root, so they share a writer domain;
 * a non-Git directory falls back to its exact realpath. Cross-process writers are
 * not serialized here: this resolves identity only within one GatewayManager.
 */
export async function resolveWriterDomain(cwd: string): Promise<string> {
  const resolved = await realpath(cwd)
  let candidate = resolved
  while (true) {
    try {
      // A normal checkout has a .git directory; a linked worktree has a .git
      // file. The nearest marker wins, matching Git's nested-worktree boundary.
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

export interface GatewayDependencies {
  /** Overridable for tests; defaults to {@link resolveWriterDomain}. */
  resolveWriterDomain?: (cwd: string) => Promise<string>
  /** Overridable for tests; defaults to a real {@link HostConnection}. */
  createConnection?: (baseUrl: string) => HostConnection
}

export function attachChildObservations<T extends { id: string }>(
  entries: readonly T[],
  sessions: readonly SessionSummary[],
): Array<T & { observation?: Record<string, unknown> }> {
  const rows = new Map(sessions.map(row => [row.sessionId as string, row]))
  return entries.map((entry) => {
    const row = rows.get(entry.id)
    if (row === undefined) return { ...entry }
    const values = row.projections?.values as Record<string, unknown> | undefined
    return {
      ...entry,
      observation: {
        workerState: row.running ? 'RUNNING' : 'IDLE',
        ...row.projections === undefined ? {} : {
          telemetry: {
            asOfSeq: row.projections.asOfSeq,
            ...values?.sessionStats === undefined ? {} : { sessionStats: values.sessionStats },
            ...values?.tokenUsage === undefined ? {} : { tokenUsage: values.tokenUsage },
          },
        },
      },
    }
  })
}

export interface GatewayConfig {
  hostUrls: string[]
  launch?: HostLaunchConfig
  defaultProvider?: string
  defaultModel?: string
  defaultReasoningEffort?: string
}

/** The five-minute aggregated progress cadence used by {@link GatewayManager.wait}. */
export const DEFAULT_WAIT_TIMEOUT_MS = 300_000

export class GatewayManager {
  private readonly connections = new Map<string, HostConnection>()
  private readonly knownUrls: string[]
  private readonly resolveDomain: (cwd: string) => Promise<string>
  private readonly createConnection: (baseUrl: string) => HostConnection
  /** Tail of the in-process writer-admission queue; serializes check-then-act within one GatewayManager. */
  private admissionTail: Promise<void> = Promise.resolve()

  constructor(private readonly config: GatewayConfig, deps: GatewayDependencies = {}) {
    this.knownUrls = [...new Set(config.hostUrls.map(normalizedUrl))]
    this.resolveDomain = deps.resolveWriterDomain ?? resolveWriterDomain
    this.createConnection = deps.createConnection ?? (baseUrl => new HostConnection(baseUrl))
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): GatewayManager {
    const urls = env.DSH_HOST_URLS === undefined
      ? [env.DSH_HOST_URL ?? 'http://127.0.0.1:8080']
      : JSON.parse(env.DSH_HOST_URLS) as unknown
    if (!Array.isArray(urls) || !urls.every(url => typeof url === 'string')) {
      throw new Error('DSH_HOST_URLS must be a JSON string array')
    }
    return new GatewayManager({
      hostUrls: urls,
      ...env.DSH_HOST_LAUNCH === undefined ? {} : { launch: parseLaunchConfig(env.DSH_HOST_LAUNCH) as HostLaunchConfig },
      defaultProvider: env.DSH_WORKER_PROVIDER ?? 'deepseek-official',
      defaultModel: env.DSH_WORKER_MODEL ?? 'deepseek-v4-flash',
      defaultReasoningEffort: env.DSH_WORKER_REASONING_EFFORT ?? 'high',
    })
  }

  connection(url = this.knownUrls[0]): HostConnection {
    if (url === undefined) throw new Error('no DSH Host URL configured')
    const baseUrl = normalizedUrl(url)
    const existing = this.connections.get(baseUrl)
    if (existing !== undefined) return existing
    const connection = this.createConnection(baseUrl)
    this.connections.set(baseUrl, connection)
    if (!this.knownUrls.includes(baseUrl)) this.knownUrls.push(baseUrl)
    return connection
  }

  async startOrConnect(input: {
    hostBaseUrl?: string | undefined
    cwd?: string | undefined
    sessionId?: string | undefined
    agentPreset?: string | undefined
  }): Promise<Record<string, unknown>> {
    const connection = this.connection(input.hostBaseUrl)
    let description
    try {
      description = await connection.ensureConnected(2_000)
    } catch (firstError) {
      if (this.config.launch === undefined) throw firstError
      await launchDetachedHost(this.config.launch)
      description = await connection.ensureConnected(15_000)
    }
    let sessionId = input.sessionId
    if (sessionId === undefined) {
      const created = unwrap(await connection.api.sessions.create({
        ...input.cwd === undefined ? {} : { cwd: input.cwd },
        ...input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset },
      }))
      sessionId = created.sessionId
    } else if (!await connection.sessionExists(sessionId)) {
      throw new Error(`session ${sessionId} does not exist on ${connection.baseUrl}`)
    }
    const snapshot = await connection.refreshSession(sessionId)
    return {
      schemaVersion: 1,
      hostBaseUrl: connection.baseUrl,
      hostInstanceId: description.hostInstanceId,
      hostVersion: description.version,
      protocolVersion: description.protocolVersion,
      taskId: sessionId,
      cwd: snapshot.cwd,
      reconnected: input.sessionId !== undefined,
    }
  }

  async locate(taskId: string): Promise<HostConnection> {
    for (const url of this.knownUrls) {
      const connection = this.connection(url)
      try {
        await connection.ensureConnected()
        if (await connection.sessionExists(taskId)) return connection
      } catch {
        // Try the next explicitly configured Host. The final error is stable.
      }
    }
    throw new Error(`task/session ${taskId} was not found on any configured DSH Host`)
  }

  private async assertWriterAvailable(connection: HostConnection, taskId: string, cwd: string): Promise<void> {
    const target = await this.resolveDomain(cwd)
    for (const row of await connection.listSessions()) {
      if (row.sessionId === taskId || row.cwd === undefined) continue
      let candidate: string
      try {
        candidate = await this.resolveDomain(row.cwd)
      } catch (error) {
        const code = error instanceof Error && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined
        // A deleted/stale cwd cannot be the current writer domain. Any other
        // resolution failure is ambiguous, so writer admission fails closed.
        if (code === 'ENOENT' || code === 'ENOTDIR') continue
        throw error
      }
      if (candidate !== target) continue
      const snapshot = await connection.refreshSession(row.sessionId)
      const packet = parseTaskPacket(snapshot.events)
      if (packet?.writerMode !== 'writer') continue
      const status = deriveObservation(snapshot).status
      if (status !== 'COMPLETED' && status !== 'FAILED') {
        throw new Error(`working tree already has writer session ${row.sessionId}; use read_only or an independent worktree`)
      }
    }
  }

  /**
   * Run one writer admission (availability check through durable task packet) while
   * no other admission for this GatewayManager is in flight. This closes the
   * in-process check-then-act race: a concurrent writer admission waits until the
   * previous packet is durable, then observes it. Distinct GatewayManager processes
   * and distinct Hosts are not serialized.
   */
  private async exclusiveWriterAdmission<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const previous = this.admissionTail
    this.admissionTail = previous.then(() => gate)
    await previous
    try { return await fn() } finally { release() }
  }

  async task(input: {
    taskId: string
    objective: string
    writerMode?: 'writer' | 'read_only' | undefined
    provider?: string | undefined
    model?: string | undefined
    reasoningEffort?: string | undefined
    context?: string | undefined
    allowedScope?: string[] | undefined
    constraints?: string[] | undefined
    acceptanceCriteria?: string[] | undefined
    verification?: string[] | undefined
    escalationConditions?: string[] | undefined
  }): Promise<Record<string, unknown>> {
    const connection = await this.locate(input.taskId)
    const snapshot = await connection.refreshSession(input.taskId)
    if (snapshot.cwd === undefined) throw new Error('task session has no authoritative cwd')
    const sessionCwd = snapshot.cwd
    const writerMode = input.writerMode ?? 'writer'

    const models = unwrap(await connection.api.sessions.models({ sessionId: input.taskId as SessionId }))
    const reasoningEffort = input.reasoningEffort ?? this.config.defaultReasoningEffort
    unwrap(await connection.api.sessions.selectModel({
      sessionId: input.taskId as SessionId,
      provider: input.provider ?? this.config.defaultProvider ?? models.current.provider,
      model: input.model ?? this.config.defaultModel ?? models.current.model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }))

    const packet: TaskPacket = {
      schemaVersion: 1,
      taskId: input.taskId,
      completionToken: randomUUID(),
      objective: input.objective,
      writerMode,
      ...input.context === undefined ? {} : { context: input.context },
      ...input.allowedScope === undefined ? {} : { allowedScope: input.allowedScope },
      ...input.constraints === undefined ? {} : { constraints: input.constraints },
      ...input.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: input.acceptanceCriteria },
      ...input.verification === undefined ? {} : { verification: input.verification },
      ...input.escalationConditions === undefined ? {} : { escalationConditions: input.escalationConditions },
    }
    // Put the human objective first so DSH Web gives the session a meaningful
    // title instead of "<dsh-supervised-task>…". The durable packet remains in
    // the same message and parseTaskPacket deliberately accepts it anywhere.
    const prompt = `${input.objective}\n\n`
      + `${TASK_PACKET_START}\n${JSON.stringify(packet)}\n${TASK_PACKET_END}\n\n`
      + 'Follow the dsh-supervised-worker contract. Only a successful supervisor_handoff with the matching taskId '
      + 'and completionToken, followed by this turn ending, can complete the task. Use paths relative to the session cwd '
      + 'for artifacts. Report repeated recovery failures with a stable worker-chosen failureSignature.'
    const queueAndConfirm = async (): Promise<Record<string, unknown>> => {
      unwrap(await connection.api.sessions.prompt({
        sessionId: input.taskId as SessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }))
      const packetDeadline = Date.now() + 10_000
      let refreshed = await connection.refreshSession(input.taskId)
      while (parseTaskPacket(refreshed.events)?.completionToken !== packet.completionToken) {
        if (Date.now() >= packetDeadline) throw new Error('task prompt was accepted but its durable task packet was not observed')
        await connection.waitForChange(250)
        refreshed = await connection.refreshSession(input.taskId)
      }
      return {
        schemaVersion: 1,
        hostInstanceId: refreshed.hostInstanceId,
        taskId: input.taskId,
        objective: input.objective,
        writerMode,
        accepted: true,
        asOfSeq: refreshed.events.at(-1)?.seq ?? -1,
      }
    }
    if (writerMode === 'writer') {
      return this.exclusiveWriterAdmission(async () => {
        await this.assertWriterAvailable(connection, input.taskId, sessionCwd)
        return queueAndConfirm()
      })
    }
    return queueAndConfirm()
  }

  async wait(input: { taskId: string; afterAsOfSeq?: number | undefined; timeoutMs?: number | undefined }): Promise<Observation> {
    // The default is the five-minute aggregated progress cadence: ordinary event
    // churn never returns early, so the supervisor issues about one long dsh_wait
    // observation per window. Only a material boundary (terminal state, approval,
    // question, checkpoint, blocker, escalation) returns before the window expires.
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, 0), 300_000)
    const connection = await this.locate(input.taskId)
    const deadline = Date.now() + timeoutMs
    let progressFromAsOfSeq = input.afterAsOfSeq
    while (true) {
      const snapshot = await connection.refreshSession(input.taskId)
      const observation = deriveObservation(snapshot)
      if (observation.taskId !== input.taskId) {
        return {
          ...observation,
          taskId: input.taskId,
          status: 'FAILED',
          stage: 'protocol',
          summary: 'The latest durable task packet does not match this session id.',
          failure: { kind: 'PROTOCOL_ERROR', message: `task packet names ${observation.taskId}`, retryable: false },
        }
      }
      if (input.afterAsOfSeq !== undefined && input.afterAsOfSeq > observation.asOfSeq) {
        throw new Error(`afterAsOfSeq ${String(input.afterAsOfSeq)} is ahead of observed asOfSeq ${String(observation.asOfSeq)}`)
      }
      progressFromAsOfSeq ??= observation.asOfSeq
      const observed = progressObservation(observation, snapshot, progressFromAsOfSeq)
      if (observation.status !== 'WAITING') return observed
      const remaining = deadline - Date.now()
      if (remaining <= 0) return timeoutObservation(observed, timeoutMs)
      await connection.waitForChange(Math.min(remaining, 1_000))
    }
  }

  async steer(taskId: string, message: string): Promise<Record<string, unknown>> {
    const connection = await this.locate(taskId)
    unwrap(await connection.api.sessions.prompt({
      sessionId: taskId as SessionId,
      mode: 'steer',
      content: [{ type: 'text', text: message }],
    }))
    return { accepted: true, taskId }
  }

  async cancel(taskId: string): Promise<Record<string, unknown>> {
    const connection = await this.locate(taskId)
    unwrap(await connection.api.sessions.cancel({ sessionId: taskId as SessionId }))
    return { accepted: true, taskId }
  }

  async answerApproval(taskId: string, outcome: 'allowed-once' | 'rejected'): Promise<Record<string, unknown>> {
    const connection = await this.locate(taskId)
    await connection.refreshSession(taskId)
    await connection.answerApproval(taskId, outcome)
    return { accepted: true, taskId, outcome }
  }

  async answerQuestion(
    taskId: string,
    answers: { id: string; selected: string[]; custom?: string | undefined }[],
  ): Promise<Record<string, unknown>> {
    const connection = await this.locate(taskId)
    await connection.refreshSession(taskId)
    await connection.answerQuestion(taskId, answers)
    return { accepted: true, taskId }
  }

  async agents(parentSessionId: string): Promise<Record<string, unknown>> {
    const connection = await this.locate(parentSessionId)
    const catalog = unwrap(await connection.api.subagents.list({ parentSessionId: parentSessionId as SessionId }))
    return {
      schemaVersion: 1,
      parentSessionId,
      ownership: {
        manager: 'DSH_ROOT',
        childCompletionDelivery: 'HOST_TO_PARENT_AUTOMATIC',
        codexRole: 'OBSERVER',
      },
      ...catalog,
      entries: attachChildObservations(catalog.entries, await connection.listSessions()),
    }
  }

  async interruptAgent(parentSessionId: string, childSessionId: string): Promise<Record<string, unknown>> {
    const connection = await this.locate(parentSessionId)
    unwrap(await connection.api.subagents.interrupt({
      parentSessionId: parentSessionId as SessionId,
      childSessionId: childSessionId as SessionId,
      mode: 'continuable',
    }))
    return { accepted: true, parentSessionId, childSessionId }
  }

  stopClients(): void {
    for (const connection of this.connections.values()) connection.stopClient()
    this.connections.clear()
  }
}
