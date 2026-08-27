import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-connection/client'
import {
  decisionPolicyDigest, DEFAULT_DECISION_POLICY, evaluateDecision, parseDecisionPolicy,
  type DecisionCategory, type DecisionPolicy,
} from '@dsh-gate/decision-policy'
import {
  deriveObservation, parseTaskPacket, progressObservation, supervisorDecisionHistory, taskBoundarySeq, taskPacketEntries, timeoutObservation,
} from './fold.js'
import {
  FileRunJournal, isRunRecordOutcome, runRecordId, type RunJournal, type RunRecord,
} from '@dsh-gate/run-journal'
import {
  HostConnection, launchDetachedHost, parseLaunchConfig, type HostLaunchConfig,
} from './host.js'
import { TASK_PACKET_END, TASK_PACKET_START, taskPacketSchema, type Observation } from './contracts.js'
import { UsageMonitorClient } from './usage-monitor.js'

interface SessionAddress {
  sessionId?: string | undefined
  /** Deprecated v1 alias for sessionId. */
  taskId?: string | undefined
}

function sessionIdOf(input: SessionAddress): string {
  if (input.sessionId !== undefined && input.taskId !== undefined && input.sessionId !== input.taskId) {
    throw new Error(`sessionId ${input.sessionId} does not match deprecated taskId ${input.taskId}`)
  }
  const sessionId = input.sessionId ?? input.taskId
  if (sessionId === undefined || sessionId.trim() === '') throw new Error('sessionId is required')
  return sessionId
}

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
  decisionPolicy?: DecisionPolicy
  shadowDecisionPolicy?: DecisionPolicy
  decisionPolicyCatalog?: DecisionPolicy[]
  runJournal?: RunJournal | false
  defaultTaskTokenBudget?: number
  usageMonitor?: UsageMonitorClient | false
}

export const DEFAULT_RUN_JOURNAL_DIR = fileURLToPath(new URL('../../../.dsh-state/memory/runs/', import.meta.url))
export const DEFAULT_DECISION_POLICY_DIR = fileURLToPath(new URL('../../../config/decision-policies/', import.meta.url))
export const DEFAULT_DECISION_POLICY_FILE = join(DEFAULT_DECISION_POLICY_DIR, '2026-08-26.v1.json')

function readDecisionPolicy(path: string): DecisionPolicy {
  return parseDecisionPolicy(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

function readDecisionPolicyCatalog(directory: string): DecisionPolicy[] {
  return readdirSync(directory).filter(name => name.endsWith('.json')).sort()
    .map(name => readDecisionPolicy(join(directory, name)))
}

/** The five-minute aggregated progress cadence used by {@link GatewayManager.wait}. */
export const DEFAULT_WAIT_TIMEOUT_MS = 300_000
/** Periodic authoritative reconciliation while mux events drive cached observations. */
export const WAIT_RECONCILE_INTERVAL_MS = 30_000

/** A writer packet owns its in-process worktree lease until its corresponding turn ends. */
export function writerLeaseHeld(events: readonly import('./contracts.js').DshEvent[]): boolean {
  const boundary = taskBoundarySeq(events)
  const packet = parseTaskPacket(events)
  if (boundary === undefined || packet?.writerMode !== 'writer') return false
  return !events.some(event => event.type === 'turn/end' && event.seq > boundary)
}

export class GatewayManager {
  private readonly connections = new Map<string, HostConnection>()
  private readonly sessionHosts = new Map<string, string>()
  private readonly knownUrls: string[]
  private readonly resolveDomain: (cwd: string) => Promise<string>
  private readonly createConnection: (baseUrl: string) => HostConnection
  private readonly decisionPolicy: DecisionPolicy
  private readonly shadowDecisionPolicy: DecisionPolicy | undefined
  private readonly decisionPolicies = new Map<string, DecisionPolicy>()
  private readonly runJournal: RunJournal | undefined
  private readonly usageMonitor: UsageMonitorClient | undefined
  private launchPromise: Promise<void> | undefined
  /** Tail of the in-process writer-admission queue; serializes check-then-act within one GatewayManager. */
  private admissionTail: Promise<void> = Promise.resolve()

  constructor(private readonly config: GatewayConfig, deps: GatewayDependencies = {}) {
    this.knownUrls = [...new Set(config.hostUrls.map(normalizedUrl))]
    this.resolveDomain = deps.resolveWriterDomain ?? resolveWriterDomain
    this.createConnection = deps.createConnection ?? (baseUrl => new HostConnection(baseUrl))
    this.decisionPolicy = config.decisionPolicy ?? DEFAULT_DECISION_POLICY
    this.shadowDecisionPolicy = config.shadowDecisionPolicy
    for (const policy of [...config.decisionPolicyCatalog ?? [], this.decisionPolicy,
      ...this.shadowDecisionPolicy === undefined ? [] : [this.shadowDecisionPolicy]]) {
      const existing = this.decisionPolicies.get(policy.version)
      if (existing !== undefined && decisionPolicyDigest(existing) !== decisionPolicyDigest(policy)) {
        throw new Error(`decision policy version ${policy.version} has conflicting contents`)
      }
      this.decisionPolicies.set(policy.version, policy)
    }
    this.runJournal = config.runJournal === false
      ? undefined
      : config.runJournal ?? new FileRunJournal(DEFAULT_RUN_JOURNAL_DIR)
    this.usageMonitor = config.usageMonitor === false ? undefined : config.usageMonitor
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): GatewayManager {
    const urls = env.DSH_HOST_URLS === undefined
      ? [env.DSH_HOST_URL ?? 'http://127.0.0.1:8080']
      : JSON.parse(env.DSH_HOST_URLS) as unknown
    if (!Array.isArray(urls) || !urls.every(url => typeof url === 'string')) {
      throw new Error('DSH_HOST_URLS must be a JSON string array')
    }
    const policyDirectory = env.DSH_DECISION_POLICY_DIR ?? DEFAULT_DECISION_POLICY_DIR
    const catalog = readDecisionPolicyCatalog(policyDirectory)
    const filePolicy = readDecisionPolicy(env.DSH_DECISION_POLICY_FILE ?? DEFAULT_DECISION_POLICY_FILE)
    const inlinePolicy = env.DSH_DECISION_POLICY_JSON === undefined
      ? undefined
      : parseDecisionPolicy(JSON.parse(env.DSH_DECISION_POLICY_JSON) as unknown)
    const shadowPolicy = env.DSH_DECISION_SHADOW_POLICY_FILE === undefined
      ? undefined
      : readDecisionPolicy(env.DSH_DECISION_SHADOW_POLICY_FILE)
    const defaultTaskTokenBudget = env.DSH_DEFAULT_TASK_TOKEN_BUDGET === undefined
      ? undefined
      : Number(env.DSH_DEFAULT_TASK_TOKEN_BUDGET)
    if (defaultTaskTokenBudget !== undefined
      && (!Number.isSafeInteger(defaultTaskTokenBudget) || defaultTaskTokenBudget <= 0)) {
      throw new Error('DSH_DEFAULT_TASK_TOKEN_BUDGET must be a positive integer')
    }
    return new GatewayManager({
      hostUrls: urls,
      ...env.DSH_HOST_LAUNCH === undefined ? {} : { launch: parseLaunchConfig(env.DSH_HOST_LAUNCH) as HostLaunchConfig },
      defaultProvider: env.DSH_WORKER_PROVIDER ?? 'deepseek-official',
      defaultModel: env.DSH_WORKER_MODEL ?? 'deepseek-v4-flash',
      defaultReasoningEffort: env.DSH_WORKER_REASONING_EFFORT ?? 'high',
      decisionPolicy: inlinePolicy ?? filePolicy,
      ...shadowPolicy === undefined ? {} : { shadowDecisionPolicy: shadowPolicy },
      decisionPolicyCatalog: catalog,
      ...defaultTaskTokenBudget === undefined ? {} : { defaultTaskTokenBudget },
      ...env.DSH_USAGE_MONITOR_URL === undefined
        ? {}
        : { usageMonitor: new UsageMonitorClient(env.DSH_USAGE_MONITOR_URL) },
      runJournal: env.DSH_RUN_JOURNAL_ENABLED === 'false'
        ? false
        : new FileRunJournal(env.DSH_RUN_JOURNAL_DIR ?? DEFAULT_RUN_JOURNAL_DIR),
    })
  }

  private policiesFor(snapshot: Parameters<typeof deriveObservation>[0]): {
    active: DecisionPolicy
    shadow?: DecisionPolicy
  } {
    const packet = parseTaskPacket(snapshot.events)
    const pin = packet?.schemaVersion === 2 ? packet.decisionPolicy : undefined
    if (pin === undefined) return {
      active: this.decisionPolicy,
      ...this.shadowDecisionPolicy === undefined ? {} : { shadow: this.shadowDecisionPolicy },
    }
    const active = this.decisionPolicies.get(pin.activeVersion)
    if (active === undefined || decisionPolicyDigest(active) !== pin.activeDigest) {
      throw new Error(`pinned decision policy ${pin.activeVersion} is unavailable or changed`)
    }
    if (pin.shadowVersion === undefined && pin.shadowDigest === undefined) return { active }
    if (pin.shadowVersion === undefined || pin.shadowDigest === undefined) throw new Error('pinned shadow policy identity is incomplete')
    const shadow = this.decisionPolicies.get(pin.shadowVersion)
    if (shadow === undefined || decisionPolicyDigest(shadow) !== pin.shadowDigest) {
      throw new Error(`pinned shadow decision policy ${pin.shadowVersion} is unavailable or changed`)
    }
    return { active, shadow }
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

  private async launchConfiguredHost(): Promise<void> {
    if (this.config.launch === undefined) throw new Error('no DSH Host launch command is configured')
    this.launchPromise ??= launchDetachedHost(this.config.launch).finally(() => { this.launchPromise = undefined })
    await this.launchPromise
    const first = this.knownUrls[0]
    if (first !== undefined) await this.connection(first).ensureConnected(15_000)
  }

  async startOrConnect(input: {
    hostBaseUrl?: string | undefined
    cwd?: string | undefined
    sessionId?: string | undefined
    agentPreset?: string | undefined
  }): Promise<Record<string, unknown>> {
    const reconnectByDiscovery = input.sessionId !== undefined && input.hostBaseUrl === undefined
    const connection = reconnectByDiscovery
      ? await this.locate(input.sessionId as string)
      : this.connection(input.hostBaseUrl)
    let description
    if (reconnectByDiscovery) {
      description = await connection.ensureConnected()
    } else {
      try {
        description = await connection.ensureConnected(2_000)
      } catch (firstError) {
        if (this.config.launch === undefined) throw firstError
        await launchDetachedHost(this.config.launch)
        description = await connection.ensureConnected(15_000)
      }
    }
    let sessionId = input.sessionId
    if (sessionId === undefined) {
      const created = unwrap(await connection.api.sessions.create({
        ...input.cwd === undefined ? {} : { cwd: input.cwd },
        ...input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset },
      }))
      sessionId = created.sessionId
    } else if (!reconnectByDiscovery && !await connection.sessionExists(sessionId)) {
      throw new Error(`session ${sessionId} does not exist on ${connection.baseUrl}`)
    }
    this.sessionHosts.set(sessionId, connection.baseUrl)
    const snapshot = await connection.refreshSession(sessionId)
    return {
      schemaVersion: 1,
      hostBaseUrl: connection.baseUrl,
      hostInstanceId: description.hostInstanceId,
      hostVersion: description.version,
      protocolVersion: description.protocolVersion,
      sessionId,
      // Compatibility alias for v1 callers. New control calls use sessionId + runId.
      taskId: sessionId,
      cwd: snapshot.cwd,
      reconnected: input.sessionId !== undefined,
      hostOwnership: 'INDEPENDENT',
      disconnectBehavior: 'HOST_AND_SESSION_CONTINUE',
      usageMonitorConfigured: this.usageMonitor !== undefined,
    }
  }

  async locate(taskId: string, allowLaunch = true): Promise<HostConnection> {
    const boundUrl = this.sessionHosts.get(taskId)
    if (boundUrl !== undefined) {
      const bound = this.connection(boundUrl)
      try {
        await bound.ensureConnected()
        if (await bound.sessionExists(taskId)) return bound
        this.sessionHosts.delete(taskId)
      } catch {
        // A stale in-memory binding after MCP/Host restart is only a hint. Scan
        // every configured Host before deciding the session is unavailable.
        this.sessionHosts.delete(taskId)
      }
    }
    const failures: string[] = []
    let reachable = 0
    for (const url of this.knownUrls) {
      const connection = this.connection(url)
      try {
        await connection.ensureConnected()
        reachable++
        if (await connection.sessionExists(taskId)) {
          this.sessionHosts.set(taskId, connection.baseUrl)
          return connection
        }
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (reachable === 0) {
      if (allowLaunch && this.config.launch !== undefined) {
        await this.launchConfiguredHost()
        return this.locate(taskId, false)
      }
      throw new Error(`could not connect to any configured DSH Host while locating session ${taskId}: ${failures.join('; ')}`)
    }
    const unavailable = failures.length === 0 ? '' : ` (${failures.length} Host(s) unavailable)`
    throw new Error(`session ${taskId} was not found on any reachable configured DSH Host${unavailable}`)
  }

  private async assertWriterAvailable(connection: HostConnection, cwd: string): Promise<void> {
    const target = await this.resolveDomain(cwd)
    for (const row of await connection.listSessions()) {
      if (row.cwd === undefined) continue
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
      if (writerLeaseHeld(snapshot.events)) {
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

  async task(input: SessionAddress & {
    requestId?: string | undefined
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
    parentRunId?: string | undefined
    baseline?: { head?: string | undefined; statusSummary: string } | undefined
    authority?: {
      maxDirectChildren?: number | undefined
      preAuthorizedActions?: string[] | undefined
      preAuthorizedDecisionCategories?: DecisionCategory[] | undefined
    } | undefined
    tokenBudget?: { maxTokens: number } | undefined
  }): Promise<Record<string, unknown>> {
    const sessionId = sessionIdOf(input)
    const connection = await this.locate(sessionId)
    const snapshot = await connection.refreshSession(sessionId)
    if (snapshot.cwd === undefined) throw new Error('task session has no authoritative cwd')
    const sessionCwd = snapshot.cwd
    const writerMode = input.writerMode ?? 'writer'
    const requestId = input.requestId ?? randomUUID()
    const budget = input.tokenBudget ?? (this.config.defaultTaskTokenBudget === undefined
      ? undefined
      : { maxTokens: this.config.defaultTaskTokenBudget })
    const requestDigest = createHash('sha256').update(JSON.stringify({
      sessionId,
      objective: input.objective,
      writerMode,
      provider: input.provider,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      context: input.context,
      allowedScope: input.allowedScope,
      constraints: input.constraints,
      acceptanceCriteria: input.acceptanceCriteria,
      verification: input.verification,
      escalationConditions: input.escalationConditions,
      parentRunId: input.parentRunId,
      baseline: input.baseline,
      authority: input.authority,
      budget,
    })).digest('hex')

    const reconciledResponse = (candidate: typeof snapshot): Record<string, unknown> | undefined => {
      const entry = taskPacketEntries(candidate.events).find(({ packet }) =>
        packet.schemaVersion === 2 && packet.requestId === requestId)
      if (entry === undefined || entry.packet.schemaVersion !== 2) return undefined
      if (entry.packet.requestDigest !== requestDigest) {
        throw new Error(`requestId ${requestId} was already used with a different task payload`)
      }
      return {
        schemaVersion: 1,
        hostInstanceId: candidate.hostInstanceId,
        sessionId,
        taskId: sessionId,
        requestId,
        runId: entry.packet.runId,
        objective: entry.packet.objective,
        writerMode: entry.packet.writerMode,
        accepted: true,
        reconciled: true,
        asOfSeq: candidate.events.at(-1)?.seq ?? -1,
        ...entry.packet.budget === undefined ? {} : { tokenBudget: entry.packet.budget },
        disconnectBehavior: 'HOST_CONTINUES',
      }
    }
    const existing = reconciledResponse(snapshot)
    if (existing !== undefined) return existing

    const models = unwrap(await connection.api.sessions.models({ sessionId: sessionId as SessionId }))
    const reasoningEffort = input.reasoningEffort ?? this.config.defaultReasoningEffort
    unwrap(await connection.api.sessions.selectModel({
      sessionId: sessionId as SessionId,
      provider: input.provider ?? this.config.defaultProvider ?? models.current.provider,
      model: input.model ?? this.config.defaultModel ?? models.current.model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }))

    const runId = randomUUID()
    const packet = taskPacketSchema.parse({
      schemaVersion: 2,
      sessionId,
      runId,
      completionToken: randomUUID(),
      objective: input.objective,
      writerMode,
      requestId,
      requestDigest,
      ...budget === undefined ? {} : { budget },
      decisionPolicy: {
        activeVersion: this.decisionPolicy.version,
        activeDigest: decisionPolicyDigest(this.decisionPolicy),
        ...this.shadowDecisionPolicy === undefined ? {} : {
          shadowVersion: this.shadowDecisionPolicy.version,
          shadowDigest: decisionPolicyDigest(this.shadowDecisionPolicy),
        },
      },
      // Temporary v1 worker compatibility; removed after every installed worker
      // consumes sessionId + runId directly.
      taskId: sessionId,
      ...input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId },
      ...input.baseline === undefined ? {} : { baseline: input.baseline },
      ...input.context === undefined ? {} : { context: input.context },
      ...input.allowedScope === undefined ? {} : { allowedScope: input.allowedScope },
      ...input.constraints === undefined ? {} : { constraints: input.constraints },
      ...input.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: input.acceptanceCriteria },
      ...input.verification === undefined ? {} : { verification: input.verification },
      ...input.escalationConditions === undefined ? {} : { escalationConditions: input.escalationConditions },
      ...input.authority === undefined ? {} : { authority: input.authority },
    })
    // Put the human objective first so DSH Web gives the session a meaningful
    // title instead of "<dsh-supervised-task>…". The durable packet remains in
    // the same message and parseTaskPacket deliberately accepts it anywhere.
    const prompt = `${input.objective}\n\n`
      + `${TASK_PACKET_START}\n${JSON.stringify(packet)}\n${TASK_PACKET_END}\n\n`
      + 'Follow the dsh-supervised-worker contract. Only a successful supervisor_handoff with the matching sessionId, '
      + 'runId, and completionToken, followed by this turn ending, can complete the task. Use paths relative to the session cwd '
      + 'for artifacts. Report repeated recovery failures with a stable worker-chosen failureSignature. '
      + 'The DSH Host enforces any task token budget even when the external supervisor is disconnected.'
    const queueAndConfirm = async (): Promise<Record<string, unknown>> => {
      unwrap(await connection.api.sessions.prompt({
        sessionId: sessionId as SessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }))
      const packetDeadline = Date.now() + 10_000
      let refreshed = await connection.refreshSession(sessionId)
      while (parseTaskPacket(refreshed.events)?.completionToken !== packet.completionToken) {
        if (Date.now() >= packetDeadline) throw new Error('task prompt was accepted but its durable task packet was not observed')
        await connection.waitForChange(250)
        refreshed = await connection.refreshSession(sessionId)
      }
      return {
        schemaVersion: 1,
        hostInstanceId: refreshed.hostInstanceId,
        sessionId,
        taskId: sessionId,
        requestId,
        runId,
        objective: input.objective,
        writerMode,
        accepted: true,
        asOfSeq: refreshed.events.at(-1)?.seq ?? -1,
        ...budget === undefined ? {} : { tokenBudget: budget },
        disconnectBehavior: 'HOST_CONTINUES',
      }
    }
    return this.exclusiveWriterAdmission(async () => {
      const latest = await connection.refreshSession(sessionId)
      const reconciled = reconciledResponse(latest)
      if (reconciled !== undefined) return reconciled
      if (writerMode === 'writer') await this.assertWriterAvailable(connection, sessionCwd)
      return queueAndConfirm()
    })
  }

  private observationForRun(
    snapshot: Parameters<typeof deriveObservation>[0],
    sessionId: string,
    runId: string | undefined,
  ): Observation {
    const policies = this.policiesFor(snapshot)
    const observation = deriveObservation(snapshot, policies.active, policies.shadow)
    if (observation.sessionId !== sessionId) {
      return {
        ...observation,
        sessionId,
        taskId: sessionId,
        status: 'FAILED',
        stage: 'protocol',
        summary: 'The latest durable task packet does not match this session id.',
        failure: { kind: 'PROTOCOL_ERROR', message: `task packet names ${observation.sessionId}`, retryable: false },
        decision: evaluateDecision({ signal: 'TERMINAL_FAILURE' }, policies.active),
      }
    }
    if (runId !== undefined && runId !== observation.runId) {
      return {
        ...observation,
        status: 'FAILED',
        stage: 'stale-run',
        summary: `The requested run ${runId} is stale; the active run is ${observation.runId}.`,
        failure: {
          kind: 'PROTOCOL_ERROR',
          message: `stale run ${runId}; active run is ${observation.runId}`,
          retryable: false,
          stale: true,
        },
        decision: evaluateDecision({ signal: 'TERMINAL_FAILURE' }, policies.active),
      }
    }
    return observation
  }

  private async withRunJournal(
    observation: Observation,
    snapshot: Parameters<typeof deriveObservation>[0],
  ): Promise<Observation> {
    if (this.usageMonitor !== undefined) {
      observation = { ...observation, usageMonitor: await this.usageMonitor.observeSession(observation.sessionId) }
    }
    const journal = this.runJournal
    const packet = parseTaskPacket(snapshot.events)
    const journalableFailure = observation.status === 'FAILED'
      && (observation.failure?.kind === 'WORKER_FAILED' || observation.failure?.kind === 'MISSING_HANDOFF')
    if (journal === undefined || packet === undefined
      || (!isRunRecordOutcome(observation.status) || (observation.status === 'FAILED' && !journalableFailure))) return observation
    const recordId = runRecordId(observation.sessionId, observation.runId)
    const policies = this.policiesFor(snapshot)
    const value: RunRecord = {
      schemaVersion: 1,
      recordId,
      recordedAt: new Date().toISOString(),
      sessionId: observation.sessionId,
      runId: observation.runId,
      hostInstanceId: observation.hostInstanceId,
      objective: observation.objective,
      outcome: observation.status,
      stage: observation.stage,
      summary: observation.summary,
      workerState: observation.workerState,
      ...packet.schemaVersion === 2 && packet.baseline !== undefined ? {
        baseline: {
          statusSummary: packet.baseline.statusSummary,
          ...packet.baseline.head === undefined ? {} : { head: packet.baseline.head },
        },
      } : {},
      files: observation.files.slice(0, 200),
      verification: observation.verification.slice(0, 100),
      decisions: supervisorDecisionHistory(snapshot, policies.active, policies.shadow),
      ...observation.failure === undefined ? {} : { failure: observation.failure },
      ...observation.budget === undefined ? {} : { budget: {
        limitTokens: observation.budget.limitTokens,
        observedTokens: observation.budget.observedTokens,
        remainingTokens: observation.budget.remainingTokens,
        exhausted: observation.budget.exhausted,
        coverage: observation.budget.coverage,
        enforcement: observation.budget.enforcement,
      } },
      ...observation.projectActivity === undefined ? {} : { projectActivity: observation.projectActivity },
      artifacts: observation.artifacts,
      truncation: {
        files: observation.files.length > 200,
        verification: observation.verification.length > 100,
      },
      provenance: {
        boundarySeq: observation.boundarySeq,
        asOfSeq: observation.asOfSeq,
        generatedBy: 'dsh-gate-runtime',
        completionProtocolVerified: observation.status === 'COMPLETED',
        modelCallsUsed: 0,
      },
    }
    try {
      const result = await journal.record(value)
      return { ...observation, journal: { recorded: true, recordId, created: result.created } }
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error ? error.name : 'UNKNOWN'
      return { ...observation, journal: { recorded: false, recordId, warning: `run journal write failed (${code})` } }
    }
  }

  /** Discover supervised runs from DSH's authoritative session store after client/context loss. */
  async runs(allowLaunch = true): Promise<Record<string, unknown>> {
    const entries: Array<Record<string, unknown>> = []
    const failures: string[] = []
    let reachable = 0
    for (const url of this.knownUrls) {
      const connection = this.connection(url)
      try {
        await connection.ensureConnected()
        reachable++
        for (const row of await connection.listSessions()) {
          const snapshot = await connection.refreshSession(row.sessionId)
          const packet = parseTaskPacket(snapshot.events)
          // Child seeds contain the root packet too; only the packet's addressed
          // session is a recoverable root run entry.
          if (packet?.schemaVersion !== 2 || packet.sessionId !== row.sessionId) continue
          const observation = this.observationForRun(snapshot, packet.sessionId, packet.runId)
          this.sessionHosts.set(packet.sessionId, connection.baseUrl)
          entries.push({
            hostBaseUrl: connection.baseUrl,
            hostInstanceId: observation.hostInstanceId,
            sessionId: packet.sessionId,
            runId: packet.runId,
            ...packet.requestId === undefined ? {} : { requestId: packet.requestId },
            objective: packet.objective,
            status: observation.status,
            workerState: observation.workerState,
            stage: observation.stage,
            asOfSeq: observation.asOfSeq,
            ...packet.budget === undefined ? {} : { tokenBudget: packet.budget, budget: observation.budget },
          })
        }
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (reachable === 0 && allowLaunch && this.config.launch !== undefined) {
      await this.launchConfiguredHost()
      return this.runs(false)
    }
    if (reachable === 0) throw new Error(`could not connect to any configured DSH Host: ${failures.join('; ')}`)
    return {
      schemaVersion: 1,
      authoritativeSource: 'DSH_HOST_SESSIONS',
      entries,
      unavailableHosts: failures.length,
    }
  }

  /** Reattach to one durable run without replaying or duplicating its task prompt. */
  async recover(input: SessionAddress & { runId?: string | undefined }): Promise<Observation> {
    const sessionId = sessionIdOf(input)
    const connection = await this.locate(sessionId)
    const snapshot = await connection.refreshSession(sessionId)
    const observation = this.observationForRun(snapshot, sessionId, input.runId)
    const recovered: Observation = observation.recovery?.kind === 'CONTINUATION_REQUIRED'
      ? observation
      : {
          ...observation,
          recovery: {
            kind: 'REATTACHED',
            reason: 'MCP_OR_CODEX_CLIENT_RECONNECTED',
          },
        }
    return this.withRunJournal(recovered, snapshot)
  }

  async wait(input: SessionAddress & { runId?: string | undefined; afterAsOfSeq?: number | undefined; timeoutMs?: number | undefined }): Promise<Observation> {
    // The default is the five-minute aggregated progress cadence: ordinary event
    // churn never returns early, so the supervisor issues about one long dsh_wait
    // observation per window. Only a material boundary (terminal state, approval,
    // question, checkpoint, blocker, escalation) returns before the window expires.
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, 0), 300_000)
    const sessionId = sessionIdOf(input)
    const connection = await this.locate(sessionId)
    const deadline = Date.now() + timeoutMs
    let progressFromAsOfSeq = input.afterAsOfSeq
    let nextReconcileAt = Date.now() + WAIT_RECONCILE_INTERVAL_MS
    let snapshot = await connection.refreshSession(sessionId)
    let authoritative = true
    while (true) {
      const observation = this.observationForRun(snapshot, sessionId, input.runId)
      if (input.afterAsOfSeq !== undefined && input.afterAsOfSeq > observation.asOfSeq) {
        throw new Error(`afterAsOfSeq ${String(input.afterAsOfSeq)} is ahead of observed asOfSeq ${String(observation.asOfSeq)}`)
      }
      progressFromAsOfSeq ??= observation.asOfSeq
      const observed = progressObservation(observation, snapshot, progressFromAsOfSeq)
      if (observation.decision?.timing === 'immediate') {
        // Mux frames make boundaries visible immediately, but reconcile once
        // before returning so missing frames or replay state cannot decide a
        // material/terminal result from cache alone.
        if (!authoritative) {
          snapshot = await connection.refreshSession(sessionId)
          authoritative = true
          nextReconcileAt = Date.now() + WAIT_RECONCILE_INTERVAL_MS
          continue
        }
        return this.withRunJournal(observed, snapshot)
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        // The cadence observation is also an externally visible boundary; make
        // its final event/tool/token totals authoritative.
        if (!authoritative) {
          snapshot = await connection.refreshSession(sessionId)
          authoritative = true
          const finalObservation = this.observationForRun(snapshot, sessionId, input.runId)
          const finalObserved = progressObservation(finalObservation, snapshot, progressFromAsOfSeq)
          const result = finalObservation.decision?.timing !== 'immediate'
            ? timeoutObservation(finalObserved, timeoutMs)
            : finalObserved
          return this.withRunJournal(result, snapshot)
        }
        return this.withRunJournal(timeoutObservation(observed, timeoutMs), snapshot)
      }
      const untilReconcile = Math.max(0, nextReconcileAt - Date.now())
      const changed = await connection.waitForChange(Math.min(remaining, untilReconcile))
      if (changed) {
        snapshot = connection.cachedSession(sessionId) ?? snapshot
        authoritative = false
      } else {
        snapshot = await connection.refreshSession(sessionId)
        authoritative = true
        nextReconcileAt = Date.now() + WAIT_RECONCILE_INTERVAL_MS
      }
    }
  }

  private assertCurrentRun(snapshot: Parameters<typeof deriveObservation>[0], runId: string | undefined): Observation {
    const policies = this.policiesFor(snapshot)
    const observation = deriveObservation(snapshot, policies.active, policies.shadow)
    if (runId !== undefined && observation.runId !== runId) {
      throw new Error(`stale run ${runId}; active run is ${observation.runId}`)
    }
    return observation
  }

  async steer(input: SessionAddress & { runId?: string | undefined; message: string }): Promise<Record<string, unknown>> {
    const sessionId = sessionIdOf(input)
    const connection = await this.locate(sessionId)
    this.assertCurrentRun(await connection.refreshSession(sessionId), input.runId)
    unwrap(await connection.api.sessions.prompt({
      sessionId: sessionId as SessionId,
      mode: 'steer',
      content: [{ type: 'text', text: input.message }],
    }))
    return { accepted: true, sessionId, taskId: sessionId, runId: input.runId }
  }

  async cancel(input: SessionAddress & { runId?: string | undefined }): Promise<Record<string, unknown>> {
    const sessionId = sessionIdOf(input)
    const connection = await this.locate(sessionId)
    this.assertCurrentRun(await connection.refreshSession(sessionId), input.runId)
    unwrap(await connection.api.sessions.cancel({ sessionId: sessionId as SessionId }))
    return { accepted: true, sessionId, taskId: sessionId, runId: input.runId }
  }

  async answerApproval(input: SessionAddress & { runId?: string | undefined; rpcId: string; outcome: 'allowed-once' | 'rejected' }): Promise<Record<string, unknown>> {
    const sessionId = sessionIdOf(input)
    const connection = await this.locate(sessionId)
    this.assertCurrentRun(await connection.refreshSession(sessionId), input.runId)
    await connection.answerApproval(sessionId, input.rpcId, input.outcome)
    return { accepted: true, sessionId, taskId: sessionId, runId: input.runId, rpcId: input.rpcId, outcome: input.outcome }
  }

  async answerQuestion(input: SessionAddress & {
    runId?: string | undefined
    rpcId: string
    answers: { id: string; selected: string[]; custom?: string | undefined }[]
  }): Promise<Record<string, unknown>> {
    const sessionId = sessionIdOf(input)
    const connection = await this.locate(sessionId)
    this.assertCurrentRun(await connection.refreshSession(sessionId), input.runId)
    await connection.answerQuestion(sessionId, input.rpcId, input.answers)
    return { accepted: true, sessionId, taskId: sessionId, runId: input.runId, rpcId: input.rpcId }
  }

  async agents(input: SessionAddress & { runId?: string | undefined }): Promise<Record<string, unknown>> {
    const parentSessionId = sessionIdOf(input)
    const connection = await this.locate(parentSessionId)
    this.assertCurrentRun(await connection.refreshSession(parentSessionId), input.runId)
    const catalog = unwrap(await connection.api.subagents.list({ parentSessionId: parentSessionId as SessionId }))
    return {
      schemaVersion: 1,
      parentSessionId,
      sessionId: parentSessionId,
      runId: input.runId,
      ownership: {
        manager: 'DSH_ROOT',
        childCompletionDelivery: 'HOST_TO_PARENT_AUTOMATIC',
        codexRole: 'OBSERVER',
      },
      ...catalog,
      entries: attachChildObservations(catalog.entries, await connection.listSessions()),
    }
  }

  async interruptAgent(input: SessionAddress & { runId?: string | undefined; childSessionId: string }): Promise<Record<string, unknown>> {
    const parentSessionId = sessionIdOf(input)
    const connection = await this.locate(parentSessionId)
    this.assertCurrentRun(await connection.refreshSession(parentSessionId), input.runId)
    unwrap(await connection.api.subagents.interrupt({
      parentSessionId: parentSessionId as SessionId,
      childSessionId: input.childSessionId as SessionId,
      mode: 'continuable',
    }))
    return { accepted: true, parentSessionId, sessionId: parentSessionId, runId: input.runId, childSessionId: input.childSessionId }
  }

  stopClients(): void {
    for (const connection of this.connections.values()) connection.stopClient()
    this.connections.clear()
    this.sessionHosts.clear()
  }
}
