import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import {
  compareDecision, DEFAULT_DECISION_POLICY, evaluateDecision,
  type DecisionOutcome, type DecisionPolicy, type DecisionSignal,
} from '@dsh-gate/decision-policy'
import type { RunDecisionRecord } from '@dsh-gate/run-journal'
import {
  TASK_PACKET_END, TASK_PACKET_START,
  type DshEvent, type EditWriteActivity, type Observation, type ProgressHeartbeat,
  taskPacketSchema, supervisorProgressSchema,
  type ProjectActivity, type SupervisorProgress, type TaskPacket, type TaskRuntimeState,
} from './contracts.js'

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const candidate = block as { type?: unknown; text?: unknown; content?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') return [candidate.text]
    if (candidate.type === 'tool-result') return [textBlocks(candidate.content)]
    return []
  }).join('\n')
}

function eventText(event: DshEvent): string {
  const data = event.data as { content?: unknown; message?: { content?: unknown } }
  return textBlocks(data.content ?? data.message?.content)
}

function taskPacketBoundary(events: readonly DshEvent[]): { packet: TaskPacket; seq: number } | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const text = eventText(event)
    // The objective may itself mention either marker, including inside the
    // serialized JSON. Anchor at the final closing marker and validate each
    // preceding opening-marker candidate until the strict packet parses.
    const end = text.lastIndexOf(TASK_PACKET_END)
    if (end < 0) continue
    let before = end
    while (before >= 0) {
      const start = text.lastIndexOf(TASK_PACKET_START, before)
      if (start < 0) break
      const raw = text.slice(start + TASK_PACKET_START.length, end).trim()
      try {
        const parsed = taskPacketSchema.safeParse(JSON.parse(raw))
        if (parsed.success) return { packet: parsed.data, seq: event.seq }
      } catch { /* Try an earlier opening marker in the same message. */ }
      before = start - 1
    }
  }
  return undefined
}

export function parseTaskPacket(events: readonly DshEvent[]): TaskPacket | undefined {
  return taskPacketBoundary(events)?.packet
}

/** Every valid durable packet boundary, oldest first (used for stateless request reconciliation). */
export function taskPacketEntries(events: readonly DshEvent[]): Array<{ packet: TaskPacket; seq: number }> {
  return events.flatMap((event) => {
    if (event.type !== 'user/message') return []
    const boundary = taskPacketBoundary([event])
    return boundary === undefined ? [] : [boundary]
  })
}

/**
 * Sequence of the latest durable task-packet boundary, or undefined when the
 * session history has no valid packet. Used to bound the in-memory event cache:
 * events older than the boundary are never needed by the fold.
 */
export function taskBoundarySeq(events: readonly DshEvent[]): number | undefined {
  return taskPacketBoundary(events)?.seq
}

export function taskPacketSessionId(packet: TaskPacket): string {
  return packet.schemaVersion === 2 ? packet.sessionId : packet.taskId
}

export function taskPacketRunId(packet: TaskPacket, boundarySeq: number): string {
  return packet.schemaVersion === 2 ? packet.runId : `legacy-${String(boundarySeq)}`
}

// Project-activity summarization: the compact, bounded view of what a worker
// changed and verified. It counts distinct file paths from *successful* mutating
// tool calls (a failed edit did not change the project) and distinct targeted
// verification commands (a failed verification attempt is still worth reporting).
// Only sanitized path/label strings are surfaced — never file contents, tool
// outputs, or full tool arguments.

/** Mutating tools and the argument key that names their target project path. */
const MUTATING_TOOLS: Record<string, { pathKey: string; mutatingCommands?: ReadonlySet<string> }> = {
  edit: { pathKey: 'file_path' },
  write: { pathKey: 'file_path' },
  str_replace_editor: {
    pathKey: 'path',
    mutatingCommands: new Set(['create', 'str_replace', 'insert']),
  },
}

/** Command first-tokens treated as targeted verification (build, test, typecheck, lint). */
const VERIFICATION_TOKENS = new Set([
  'pnpm', 'npm', 'yarn', 'npx', 'bun', 'deno', 'tsc', 'vitest', 'jest', 'mocha',
  'eslint', 'prettier', 'make', 'gradle', 'mvn', 'ant', 'cargo', 'go', 'dotnet',
  'pytest', 'mypy', 'ruff',
])
const VERIFICATION_ACTIONS = new Set(['build', 'check', 'lint', 'pack', 'run', 'test', 'typecheck', 'verify'])

const MAX_PATH_LABEL = 200
const MAX_ACTIVITY_FILES = 10
const MAX_ACTIVITY_COMMANDS = 5
const MAX_COMMAND_LABEL = 60
const CLASSIFIED_NON_MUTATING_TOOLS = new Set([
  'read', 'view', 'grep', 'glob', 'find', 'ls',
  'supervisor_progress', 'supervisor_handoff', 'supervisor_report_failure',
])

/** Strip control characters and bound the length of any surfaced label. */
function cleanLabel(value: string, max: number): string | undefined {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (cleaned === '') return undefined
  return cleaned.slice(0, max)
}

function projectRelativePath(workspaceCwd: string | undefined, raw: string): string | undefined {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (cleaned === '' || cleaned.length > 4_096) return undefined
  if (workspaceCwd === undefined) {
    if (isAbsolute(cleaned)) return undefined
    const normalized = normalize(cleaned)
    if (normalized === '..' || normalized.startsWith(`..${sep}`)) return undefined
    return cleanLabel(normalized, MAX_PATH_LABEL)
  }
  const target = isAbsolute(cleaned) ? cleaned : resolve(workspaceCwd, cleaned)
  const suffix = relative(workspaceCwd, target)
  if (suffix === '' || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) return undefined
  return cleanLabel(suffix, MAX_PATH_LABEL)
}

function mutatingFilePath(name: string, argsText: string, workspaceCwd: string | undefined): string | undefined {
  const spec = MUTATING_TOOLS[name]
  if (spec === undefined) return undefined
  let args: Record<string, unknown>
  try { args = JSON.parse(argsText) as Record<string, unknown> } catch { return undefined }
  if (spec.mutatingCommands !== undefined) {
    const command = args.command
    if (typeof command !== 'string' || !spec.mutatingCommands.has(command)) return undefined
  }
  const raw = args[spec.pathKey]
  return typeof raw === 'string' ? projectRelativePath(workspaceCwd, raw) : undefined
}

function verificationCommandLabel(name: string, argsText: string): string | undefined {
  if (name !== 'bash') return undefined
  let args: Record<string, unknown>
  try { args = JSON.parse(argsText) as Record<string, unknown> } catch { return undefined }
  const command = args.command
  if (typeof command !== 'string') return undefined
  const tokens = command.trim().split(/\s+/)
  const first = tokens[0]?.toLowerCase()
  if (first === undefined || !VERIFICATION_TOKENS.has(first)) return undefined
  // Never copy a full shell command into model context. Keep only the known
  // verification executable and, when present, one generic action verb.
  const action = tokens.slice(1).map(token => token.toLowerCase()).find(token => VERIFICATION_ACTIONS.has(token))
  return cleanLabel(action === undefined ? first : `${first} ${action}`, MAX_COMMAND_LABEL)
}

type RuntimeToolOutcome = 'passed' | 'failed' | 'pending'

/** First correlated runtime outcome for each call id, indexed once per scope. */
function callOutcomes(events: readonly DshEvent[], fromSeq: number, toSeq: number): Map<string, RuntimeToolOutcome> {
  const outcomeById = new Map<string, RuntimeToolOutcome>()
  for (const event of events) {
    if (event.seq < fromSeq || event.seq > toSeq) continue
    if (event.type !== 'tool/result') continue
    const data = event.data as {
      message?: { source?: { callId?: unknown }; content?: Array<{ type?: unknown; isError?: unknown }> }
      error?: unknown
    }
    const callId = data.message?.source?.callId
    if (typeof callId !== 'string' || outcomeById.has(callId)) continue
    const resultBlock = data.message?.content?.find(block => block.type === 'tool-result')
    outcomeById.set(callId, data.error !== undefined || resultBlock?.isError === true
      ? 'failed'
      : resultBlock?.isError === false ? 'passed' : 'pending')
  }
  return outcomeById
}

/**
 * Compact project-activity summary over events in [fromSeq, toSeq]: distinct
 * project files touched by successful edit/write calls, distinct targeted
 * verification commands, completed steps, tool-call totals, and token usage.
 * All surfaced strings are bounded and sanitized; no payloads or outputs.
 */
export function projectActivityIn(
  events: readonly DshEvent[],
  fromSeq: number,
  toSeq: number,
  workspaceCwd?: string,
): ProjectActivity {
  const outcomes = callOutcomes(events, fromSeq, toSeq)
  const editFiles = new Set<string>()
  const verificationCommands = new Set<string>()
  const verificationEvidence = new Map<string, 'passed' | 'failed' | 'pending'>()
  let coverage: 'complete' | 'partial' = 'complete'
  let steps = 0
  let toolCalls = 0
  const toolCallsByName: Record<string, number> = {}
  for (const event of events) {
    if (event.seq < fromSeq || event.seq > toSeq) continue
    if (event.type === 'step/end') {
      steps += 1
      continue
    }
    if (event.type !== 'tool/call') continue
    toolCalls += 1
    const data = event.data as { name?: unknown; arguments?: unknown; callId?: unknown }
    const name = typeof data.name === 'string' ? data.name : 'unknown'
    toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1
    if (!(name in MUTATING_TOOLS) && !CLASSIFIED_NON_MUTATING_TOOLS.has(name)) coverage = 'partial'
    if (typeof data.arguments !== 'string') {
      coverage = 'partial'
      continue
    }
    const outcome = typeof data.callId === 'string' ? outcomes.get(data.callId) : undefined
    if (outcome === 'passed') {
      const path = mutatingFilePath(name, data.arguments, workspaceCwd)
      if (path !== undefined) editFiles.add(path)
    }
    const command = verificationCommandLabel(name, data.arguments)
    if (command !== undefined) {
      verificationCommands.add(command)
      verificationEvidence.set(command, outcome ?? 'pending')
    }
  }
  return {
    coverage,
    edits: { total: editFiles.size, files: [...editFiles].slice(0, MAX_ACTIVITY_FILES) },
    verification: {
      total: verificationCommands.size,
      commands: [...verificationCommands].slice(0, MAX_ACTIVITY_COMMANDS),
      evidence: [...verificationEvidence].slice(0, MAX_ACTIVITY_COMMANDS).map(([command, outcome]) => ({ command, outcome })),
    },
    steps,
    toolCalls,
    toolCallsByName,
    tokenUsage: subtractTokens(tokensAt(events, toSeq), tokensAt(events, fromSeq)),
  }
}

/** The delta-scoped edit/write + verification summary used by the heartbeat. */
function editWriteActivity(activity: ProjectActivity): EditWriteActivity {
  return { coverage: activity.coverage, edits: activity.edits, verification: activity.verification }
}

interface TokenBuckets {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

const zeroTokens = (): TokenBuckets => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

function tokenNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function usageSample(event: DshEvent): { key: string; buckets: TokenBuckets } | undefined {
  const data = event.data as { turn?: unknown; step?: unknown; chunk?: unknown; usage?: unknown }
  if (typeof data.turn !== 'number' || typeof data.step !== 'number') return undefined
  const usage = event.type === 'assistant/chunk'
    && typeof data.chunk === 'object' && data.chunk !== null
    && (data.chunk as { type?: unknown }).type === 'usage'
    ? (data.chunk as { usage?: unknown }).usage
    : event.type === 'assistant/message' ? data.usage : undefined
  if (typeof usage !== 'object' || usage === null) return undefined
  const value = usage as Record<string, unknown>
  const uncachedInputTokens = tokenNumber(value.inputTokens)
  const outputTokens = tokenNumber(value.outputTokens)
  if (uncachedInputTokens === undefined || outputTokens === undefined) return undefined
  return {
    key: `${String(data.turn)}:${String(data.step)}`,
    buckets: {
      uncachedInputTokens,
      outputTokens,
      cacheReadTokens: tokenNumber(value.cacheReadTokens) ?? 0,
      cacheWriteTokens: tokenNumber(value.cacheWriteTokens) ?? 0,
    },
  }
}

/** Mirrors DSH's tokenUsage replacement semantics without creating a second metrics store. */
function tokensAt(events: readonly DshEvent[], asOfSeq: number): TokenBuckets {
  const samples = new Map<string, TokenBuckets>()
  for (const event of events) {
    if (event.seq > asOfSeq) break
    const sample = usageSample(event)
    if (sample !== undefined) samples.set(sample.key, sample.buckets)
  }
  const totals = zeroTokens()
  for (const sample of samples.values()) {
    totals.uncachedInputTokens += sample.uncachedInputTokens
    totals.outputTokens += sample.outputTokens
    totals.cacheReadTokens += sample.cacheReadTokens
    totals.cacheWriteTokens += sample.cacheWriteTokens
  }
  return totals
}

function subtractTokens(current: TokenBuckets, previous: TokenBuckets): TokenBuckets {
  return {
    uncachedInputTokens: current.uncachedInputTokens - previous.uncachedInputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    cacheReadTokens: current.cacheReadTokens - previous.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens - previous.cacheWriteTokens,
  }
}

function activityFor(
  event: DshEvent,
  toolNames: ReadonlyMap<string, string>,
): ProgressHeartbeat['lastActivity'] {
  const data = event.data as { step?: unknown; name?: unknown; callId?: unknown; message?: { source?: { callId?: unknown } } }
  const step = typeof data.step === 'number' && Number.isInteger(data.step) && data.step >= 0 ? data.step : undefined
  const common = { seq: event.seq, time: event.time, ...step === undefined ? {} : { step } }
  switch (event.type) {
    case 'turn/start':
    case 'turn/end': return { ...common, kind: 'turn' }
    case 'step/start':
    case 'step/end': return { ...common, kind: 'step' }
    case 'assistant/chunk': return { ...common, kind: 'model_stream' }
    case 'assistant/message': return { ...common, kind: 'model_message' }
    case 'tool/call': return {
      ...common,
      kind: 'tool_call',
      ...typeof data.name === 'string' ? { toolName: data.name } : {},
    }
    case 'tool/result': {
      const callId = data.message?.source?.callId
      const toolName = typeof callId === 'string' ? toolNames.get(callId) : undefined
      return { ...common, kind: 'tool_result', ...toolName === undefined ? {} : { toolName } }
    }
    default: return undefined
  }
}

export function progressHeartbeat(state: TaskRuntimeState, requestedFromAsOfSeq: number): ProgressHeartbeat {
  const boundary = taskPacketBoundary(state.events)
  const asOfSeq = state.events.reduce((max, event) => Math.max(max, event.seq), -1)
  const fromAsOfSeq = Math.min(asOfSeq, Math.max(requestedFromAsOfSeq, boundary?.seq ?? -1))
  const scoped = state.events.filter(event => event.seq >= (boundary?.seq ?? -1) && event.seq <= asOfSeq)
  const delta = scoped.filter(event => event.seq > fromAsOfSeq)
  const toolNames = new Map<string, string>()
  for (const event of scoped) {
    if (event.type !== 'tool/call') continue
    const data = event.data as { callId?: unknown; name?: unknown }
    if (typeof data.callId === 'string' && typeof data.name === 'string') toolNames.set(data.callId, data.name)
  }
  const toolCalls = scoped.filter(event => event.type === 'tool/call')
  const deltaToolCalls = delta.filter(event => event.type === 'tool/call')
  const deltaByName: Record<string, number> = {}
  for (const event of deltaToolCalls) {
    const name = (event.data as { name?: unknown }).name
    const key = typeof name === 'string' ? name : 'unknown'
    deltaByName[key] = (deltaByName[key] ?? 0) + 1
  }
  let lastActivity: ProgressHeartbeat['lastActivity']
  for (let index = delta.length - 1; index >= 0; index--) {
    const event = delta[index]
    if (event === undefined) continue
    lastActivity = activityFor(event, toolNames)
    if (lastActivity !== undefined) break
  }
  const activity = projectActivityIn(state.events, fromAsOfSeq, asOfSeq, state.cwd)
  return {
    fromAsOfSeq,
    toAsOfSeq: asOfSeq,
    observedEvents: delta.length,
    steps: {
      completed: scoped.filter(event => event.type === 'step/end').length,
      delta: delta.filter(event => event.type === 'step/end').length,
    },
    tools: { totalCalls: toolCalls.length, deltaCalls: deltaToolCalls.length, deltaByName },
    tokenDelta: activity.tokenUsage,
    projectActivity: editWriteActivity(activity),
    ...lastActivity === undefined ? {} : { lastActivity },
  }
}

export function progressObservation(
  current: Observation,
  state: TaskRuntimeState,
  fromAsOfSeq: number,
): Observation {
  const progress = progressHeartbeat(state, fromAsOfSeq)
  return {
    ...current,
    progress,
    ...current.status === 'WAITING' && progress.toAsOfSeq > progress.fromAsOfSeq
      ? { wait: { reason: 'PROGRESS' as const } }
      : {},
  }
}

function base(state: TaskRuntimeState, packet: TaskPacket | undefined): Omit<Observation, 'status'> {
  const asOfSeq = state.events.reduce((max, event) => Math.max(max, event.seq), -1)
  const packetBoundarySeq = taskBoundarySeq(state.events) ?? -1
  const sessionId = packet === undefined ? 'unknown' : taskPacketSessionId(packet)
  return {
    schemaVersion: 1,
    hostInstanceId: state.hostInstanceId,
    taskId: sessionId,
    sessionId,
    runId: packet === undefined ? 'unknown' : taskPacketRunId(packet, packetBoundarySeq),
    objective: packet?.objective ?? '',
    workerState: state.workerState,
    stage: 'unknown',
    summary: '',
    files: [],
    verification: [],
    artifacts: [],
    ...state.telemetry === undefined ? {} : { telemetry: state.telemetry },
    ...packet?.schemaVersion === 2 && packet.budget !== undefined ? {
      budget: (() => {
        const activity = projectActivityIn(state.events, packetBoundarySeq, asOfSeq, state.cwd)
        const tokens = activity.tokenUsage
        const observedTokens = tokens.uncachedInputTokens + tokens.outputTokens
          + tokens.cacheReadTokens + tokens.cacheWriteTokens
        return {
          limitTokens: packet.budget.maxTokens,
          observedTokens,
          remainingTokens: Math.max(0, packet.budget.maxTokens - observedTokens),
          exhausted: observedTokens >= packet.budget.maxTokens,
          coverage: 'root_session' as const,
          enforcement: 'DSH_HOST_RUNTIME' as const,
          overshootBound: 'IN_FLIGHT_MODEL_RESPONSES' as const,
        }
      })(),
    } : {},
    asOfSeq,
    boundarySeq: asOfSeq,
  }
}

function toolResultFor(events: readonly DshEvent[], callId: string, beforeSeq: number): DshEvent | undefined {
  return events.findLast((event) => {
    if (event.type !== 'tool/result' || event.seq >= beforeSeq) return false
    const data = event.data as { message?: { source?: { callId?: unknown }; content?: unknown }; error?: unknown }
    return data.error === undefined && data.message?.source?.callId === callId
  })
}

function parsedResult(event: DshEvent): unknown {
  const text = eventText(event)
  try { return JSON.parse(text) } catch { return undefined }
}

function acceptedSupervisorProgressRecords(
  events: readonly DshEvent[],
  packet: TaskPacket,
): Array<{ progress: SupervisorProgress; seq: number }> {
  const boundarySeq = taskBoundarySeq(events) ?? -1
  const calls = events.filter((event) => {
    if (event.type !== 'tool/call' || event.seq < boundarySeq) return false
    return (event.data as { name?: unknown }).name === 'supervisor_progress'
  })
  const records: Array<{ progress: SupervisorProgress; seq: number }> = []
  for (const call of calls) {
    const data = call.data as { callId?: unknown }
    if (typeof data.callId !== 'string') continue
    const result = toolResultFor(events, data.callId, Number.POSITIVE_INFINITY)
    if (result === undefined) continue
    const output = parsedResult(result) as { accepted?: unknown; progress?: unknown } | undefined
    if (output?.accepted !== true || typeof output.progress !== 'object' || output.progress === null) continue
    const raw = output.progress as Record<string, unknown>
    const sessionId = taskPacketSessionId(packet)
    const runId = taskPacketRunId(packet, boundarySeq)
    if (packet.schemaVersion === 2) {
      if (raw.sessionId !== sessionId || raw.runId !== runId) continue
    } else if (raw.taskId !== sessionId) continue
    const parsed = supervisorProgressSchema.safeParse({
      sessionId,
      runId,
      phase: raw.phase,
      milestone: raw.milestone,
      nextAction: raw.nextAction,
      ...raw.currentHypothesis === undefined ? {} : { currentHypothesis: raw.currentHypothesis },
      ...raw.risk === undefined ? {} : { risk: raw.risk },
      needsSupervisor: raw.needsSupervisor,
      ...raw.decision === undefined ? {} : { decision: raw.decision },
    })
    if (parsed.success) records.push({ progress: parsed.data, seq: result.seq })
  }
  return records
}

function latestSupervisorProgress(events: readonly DshEvent[], packet: TaskPacket): { progress: SupervisorProgress; seq: number } | undefined {
  return acceptedSupervisorProgressRecords(events, packet).at(-1)
}

/** Bounded, structured decision history for the durable run journal; no messages or reasoning are copied. */
export function supervisorDecisionHistory(
  state: TaskRuntimeState,
  decisionPolicy: DecisionPolicy = DEFAULT_DECISION_POLICY,
  shadowPolicy?: DecisionPolicy,
): RunDecisionRecord[] {
  const boundary = taskPacketBoundary(state.events)
  if (boundary === undefined) return []
  const packet = boundary.packet
  return acceptedSupervisorProgressRecords(state.events, packet).flatMap(({ progress, seq }) => {
    const request = progress.decision
    if (request === undefined && !progress.needsSupervisor) return []
    const category = request?.category ?? 'unspecified'
    const comparison = compareDecision({
      signal: 'WORKER_DECISION', category,
      impact: request?.impact ?? 'medium',
      blocking: request?.blocking ?? progress.needsSupervisor,
      ...request?.requiresHuman === undefined ? {} : { requiresHuman: request.requiresHuman },
      explicitlyPreAuthorized: packet.schemaVersion === 2
        && packet.authority?.preAuthorizedDecisionCategories?.includes(category) === true,
    }, decisionPolicy, shadowPolicy)
    const outcome = comparison.active
    return [{
      category, impact: request?.impact ?? 'medium', blocking: request?.blocking ?? progress.needsSupervisor,
      request: request?.request ?? progress.nextAction,
      timing: outcome.timing, audience: outcome.audience, action: outcome.action, reasonCode: outcome.reasonCode,
      handled: state.events.some(event => event.type === 'user/message' && event.seq > seq),
      ...comparison.shadow === undefined ? {} : { shadow: {
        policyVersion: comparison.shadow.policyVersion,
        timing: comparison.shadow.timing,
        audience: comparison.shadow.audience,
        action: comparison.shadow.action,
        reasonCode: comparison.shadow.reasonCode,
        matchedRuleId: comparison.shadow.matchedRuleId,
        differs: comparison.differs,
      } },
    }]
  }).slice(-20)
}

function handoffObservation(
  state: TaskRuntimeState,
  packet: TaskPacket,
  turnEnd: DshEvent,
): Observation | undefined {
  const calls = state.events.filter((event) => {
    if (event.type !== 'tool/call' || event.seq >= turnEnd.seq) return false
    const data = event.data as { turn?: unknown; name?: unknown }
    const end = turnEnd.data as { turn?: unknown }
    return data.turn === end.turn && data.name === 'supervisor_handoff'
  }).reverse()
  for (const call of calls) {
    const data = call.data as { callId: string; arguments: string }
    let args: Record<string, unknown>
    try { args = JSON.parse(data.arguments) as Record<string, unknown> } catch { continue }
    const result = toolResultFor(state.events, data.callId, turnEnd.seq)
    if (result === undefined) continue
    const output = parsedResult(result) as { accepted?: unknown; handoff?: unknown; artifacts?: unknown } | undefined
    if (output?.accepted !== true || !Array.isArray(output.artifacts)) continue
    let handoff: Record<string, unknown>
    if (packet.schemaVersion === 2) {
      if (typeof output.handoff !== 'object' || output.handoff === null) continue
      handoff = output.handoff as Record<string, unknown>
      if (handoff.sessionId !== packet.sessionId
        || handoff.runId !== packet.runId
        || handoff.completionToken !== packet.completionToken) continue
    } else {
      if (args.taskId !== packet.taskId || args.completionToken !== packet.completionToken) continue
      handoff = args
    }
    const common = {
      ...base(state, packet),
      boundarySeq: turnEnd.seq,
      stage: typeof handoff.stage === 'string' ? handoff.stage : 'unknown',
      summary: typeof handoff.summary === 'string' ? handoff.summary.slice(0, 2_048) : '',
      files: Array.isArray(handoff.files) ? handoff.files.filter((item): item is string => typeof item === 'string') : [],
      verification: Array.isArray(handoff.verification) ? handoff.verification as Observation['verification'] : [],
      artifacts: output.artifacts as Observation['artifacts'],
      projectActivity: projectActivityIn(state.events, state.events.at(0)?.seq ?? turnEnd.seq, turnEnd.seq, state.cwd),
      ...typeof handoff.blocker === 'string' ? { blocker: handoff.blocker } : {},
      ...typeof handoff.failureSignature === 'string' ? { failureSignature: handoff.failureSignature } : {},
      ...Array.isArray(handoff.attemptedHypotheses)
        ? { attemptedHypotheses: handoff.attemptedHypotheses.filter((item): item is string => typeof item === 'string') }
        : {},
    }
    switch (handoff.status) {
      case 'completed': return { ...common, status: 'COMPLETED' }
      case 'blocked': return { ...common, status: 'BLOCKED' }
      case 'major_checkpoint': return { ...common, status: 'MAJOR_CHECKPOINT' }
      case 'escalation_required': return { ...common, status: 'ESCALATION_REQUIRED' }
      case 'failed': return {
        ...common,
        status: 'FAILED',
        failure: { kind: 'WORKER_FAILED', message: common.summary || 'worker reported failure', retryable: false },
      }
      default: continue
    }
  }
  return undefined
}

function exhaustedFailureObservation(
  state: TaskRuntimeState,
  packet: TaskPacket,
  turnEnd: DshEvent,
): Observation | undefined {
  const end = turnEnd.data as { turn?: unknown }
  const calls = state.events.filter((event) => {
    if (event.type !== 'tool/call' || event.seq >= turnEnd.seq) return false
    const data = event.data as { turn?: unknown; name?: unknown }
    return data.turn === end.turn && data.name === 'supervisor_report_failure'
  }).reverse()
  for (const call of calls) {
    const data = call.data as { callId: string; arguments: string }
    const result = toolResultFor(state.events, data.callId, turnEnd.seq)
    const output = result === undefined ? undefined : parsedResult(result) as {
      exhausted?: unknown; failureSignature?: unknown; count?: unknown; budget?: unknown
    } | undefined
    if (output?.exhausted !== true) continue
    return {
      ...base(state, packet),
      status: 'ESCALATION_REQUIRED',
      boundarySeq: turnEnd.seq,
      stage: 'recovery-budget-exhausted',
      summary: `Reported failure recovery budget exhausted (${String(output.count)}/${String(output.budget)}).`,
      projectActivity: projectActivityIn(state.events, state.events.at(0)?.seq ?? turnEnd.seq, turnEnd.seq, state.cwd),
      ...typeof output.failureSignature === 'string' ? { failureSignature: output.failureSignature } : {},
    }
  }
  return undefined
}

function budgetTurnObservation(
  state: TaskRuntimeState,
  packet: TaskPacket,
  turnEnd: DshEvent,
): Observation | undefined {
  const reason = (turnEnd.data as { reason?: { kind?: unknown; reason?: { kind?: unknown; reason?: unknown } } }).reason
  if (reason?.kind !== 'aborted' || reason.reason?.kind !== 'hook' || typeof reason.reason.reason !== 'string') return undefined
  const text = reason.reason.reason
  const exhausted = /^dsh-gate:token-budget-exhausted;/.test(text)
  const accountingFailed = /^dsh-gate:token-budget-accounting-failed;/.test(text)
  if (!exhausted && !accountingFailed) return undefined
  const fields = new Map(text.split(';').slice(1).flatMap(part => {
    const separator = part.indexOf('=')
    return separator < 0 ? [] : [[part.slice(0, separator), part.slice(separator + 1)] as const]
  }))
  const used = Number(fields.get('used'))
  const limit = Number(fields.get('limit'))
  const common = {
    ...base(state, packet),
    boundarySeq: turnEnd.seq,
    projectActivity: projectActivityIn(state.events, state.events.at(0)?.seq ?? turnEnd.seq, turnEnd.seq, state.cwd),
  }
  if (accountingFailed) return {
    ...common,
    status: 'FAILED',
    stage: 'token-budget-accounting',
    summary: 'Host stopped the run because durable token accounting could not be reconciled safely.',
    failure: { kind: 'HOST_FAILED', message: 'token budget accounting failed closed', retryable: true },
  }
  const observedTokens = Number.isSafeInteger(used) && used >= 0
    ? used
    : common.budget?.observedTokens ?? 0
  const limitTokens = Number.isSafeInteger(limit) && limit > 0
    ? limit
    : common.budget?.limitTokens ?? observedTokens
  return {
    ...common,
    status: 'ESCALATION_REQUIRED',
    stage: 'token-budget-exhausted',
    summary: `Host-enforced task token budget exhausted (${observedTokens}/${limitTokens}).`,
    budget: {
      limitTokens,
      observedTokens,
      remainingTokens: 0,
      exhausted: true,
      coverage: 'run_tree',
      enforcement: 'DSH_HOST_RUNTIME',
      overshootBound: 'IN_FLIGHT_MODEL_RESPONSES',
    },
  }
}

function deriveObservationRaw(state: TaskRuntimeState, decisionPolicy: DecisionPolicy, shadowPolicy?: DecisionPolicy): Observation {
  const boundary = taskPacketBoundary(state.events)
  const packet = boundary?.packet
  const commonBase = base(state, packet)
  const progressRecord = packet === undefined ? undefined : latestSupervisorProgress(state.events, packet)
  const decisionRequest = progressRecord?.progress.decision
  const supervisorResponded = progressRecord === undefined
    ? false
    : state.events.some(event => event.type === 'user/message' && event.seq > progressRecord.seq)
  const workerDecision = progressRecord === undefined || supervisorResponded
    || (decisionRequest === undefined && !progressRecord.progress.needsSupervisor)
    ? undefined
    : compareDecision({
      signal: 'WORKER_DECISION',
      category: decisionRequest?.category ?? 'unspecified',
      impact: decisionRequest?.impact ?? 'medium',
      blocking: decisionRequest?.blocking ?? progressRecord.progress.needsSupervisor,
      ...decisionRequest?.requiresHuman === undefined ? {} : { requiresHuman: decisionRequest.requiresHuman },
      explicitlyPreAuthorized: packet?.schemaVersion === 2
        && packet.authority?.preAuthorizedDecisionCategories?.includes(decisionRequest?.category ?? 'unspecified') === true,
    }, decisionPolicy, shadowPolicy)
  const activeWorkerDecision = workerDecision?.active
  const common = {
    ...commonBase,
    ...progressRecord === undefined ? {} : { supervisorProgress: progressRecord.progress },
    ...activeWorkerDecision === undefined ? {} : { decision: activeWorkerDecision },
    ...workerDecision?.shadow === undefined ? {} : {
      decisionShadow: { ...workerDecision.shadow, differs: workerDecision.differs },
    },
  }
  if (packet === undefined) return {
    ...common,
    status: 'FAILED',
    failure: { kind: 'PROTOCOL_ERROR', message: 'session has no valid dsh-gate task packet', retryable: false },
  }
  if (state.hostError !== undefined) return {
    ...common,
    status: 'FAILED',
    stage: 'host',
    summary: state.hostError.slice(0, 2_048),
    failure: { kind: 'HOST_FAILED', message: state.hostError, retryable: true },
  }
  if (state.pendingApproval !== undefined) return {
    ...common, status: 'APPROVAL_REQUIRED', stage: 'approval', summary: 'Worker is waiting for approval.', approval: state.pendingApproval,
  }
  if (state.pendingQuestion !== undefined) return {
    ...common, status: 'QUESTION_REQUIRED', stage: 'question', summary: 'Worker is waiting for an answer.', question: state.pendingQuestion,
  }

  if (activeWorkerDecision?.timing === 'immediate' && progressRecord !== undefined && !supervisorResponded) return {
    ...common,
    status: 'SUPERVISOR_REQUIRED',
    boundarySeq: progressRecord.seq,
    stage: progressRecord.progress.phase,
    summary: decisionRequest?.request
      ?? (progressRecord?.progress.risk === undefined
        ? progressRecord?.progress.milestone ?? 'Worker requested a supervisor decision.'
        : `${progressRecord.progress.milestone} Risk: ${progressRecord.progress.risk}`.slice(0, 2_048)),
  }

  const scopedState = boundary === undefined
    ? state
    : { ...state, events: state.events.filter(event => event.seq >= boundary.seq) }
  const turnEnd = scopedState.events.findLast(event => event.type === 'turn/end')
  const turnStart = scopedState.events.findLast(event => event.type === 'turn/start')
  if (turnStart !== undefined && (turnEnd === undefined || turnStart.seq > turnEnd.seq)) {
    return { ...common, status: 'WAITING', stage: 'running', summary: 'The supervised turn has not ended.' }
  }
  if (turnEnd !== undefined) {
    const handoff = handoffObservation(scopedState, packet, turnEnd)
    if (handoff !== undefined) return handoff
    const exhausted = exhaustedFailureObservation(scopedState, packet, turnEnd)
    if (exhausted !== undefined) return exhausted
    const budget = budgetTurnObservation(scopedState, packet, turnEnd)
    if (budget !== undefined) return budget
    const reason = (turnEnd.data as { reason?: { kind?: unknown } }).reason?.kind
    const missing = reason === 'completed'
    const interrupted = reason === 'interrupted'
    return {
      ...common,
      status: 'FAILED',
      boundarySeq: turnEnd.seq,
      stage: interrupted ? 'host-restart-interrupted' : 'turn-ended',
      summary: missing
        ? 'Turn ended without a valid supervisor handoff.'
        : interrupted
          ? 'The Host recovered the durable session, but the in-flight turn was interrupted and requires a bounded continuation.'
          : `Worker turn ended: ${String(reason ?? 'unknown')}.`,
      failure: {
        kind: missing ? 'MISSING_HANDOFF' : interrupted ? 'HOST_FAILED' : 'WORKER_FAILED',
        message: missing ? 'turn/end is not success without a valid matching supervisor_handoff result' : `turn ended with ${String(reason ?? 'unknown')}`,
        retryable: missing || interrupted,
      },
      ...interrupted && packet.schemaVersion === 2 ? {
        recovery: {
          kind: 'CONTINUATION_REQUIRED' as const,
          reason: 'HOST_RESTART_INTERRUPTED',
          parentRunId: packet.runId,
        },
      } : {},
    }
  }
  return { ...common, status: 'WAITING', stage: state.workerState === 'RUNNING' ? 'running' : 'idle', summary: 'No completed supervisor boundary observed.' }
}

function protocolSignal(observation: Observation): DecisionSignal {
  switch (observation.status) {
    case 'WAITING': return observation.supervisorProgress === undefined ? 'WAIT' : 'PROGRESS'
    case 'APPROVAL_REQUIRED': return 'APPROVAL'
    case 'QUESTION_REQUIRED': return 'QUESTION'
    case 'SUPERVISOR_REQUIRED': return 'WORKER_DECISION'
    case 'MAJOR_CHECKPOINT': return 'CHECKPOINT'
    case 'COMPLETED': return 'TERMINAL_SUCCESS'
    default: return 'TERMINAL_FAILURE'
  }
}

/** Fold runtime state and attach the explainable policy outcome that controls delivery timing. */
export function deriveObservation(
  state: TaskRuntimeState,
  decisionPolicy: DecisionPolicy = DEFAULT_DECISION_POLICY,
  shadowPolicy?: DecisionPolicy,
): Observation {
  const observation = deriveObservationRaw(state, decisionPolicy, shadowPolicy)
  if (observation.decision !== undefined) return observation
  const signal = protocolSignal(observation)
  const decision: DecisionOutcome = evaluateDecision({ signal }, decisionPolicy)
  return { ...observation, decision }
}

export function timeoutObservation(current: Observation, timeoutMs: number): Observation {
  if (current.status !== 'WAITING') return current
  return { ...current, wait: { reason: 'TIMEOUT', timeoutMs } }
}
