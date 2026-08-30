import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import {
  compareDecision, DEFAULT_DECISION_POLICY, evaluateDecision,
  type DecisionOutcome, type DecisionPolicy, type DecisionSignal,
} from '@dsh-gate/decision-policy'
import type { RunDecisionRecord } from '@dsh-gate/run-journal'
import {
  HANDOFF_ARTIFACT_PATH_LIMIT, HANDOFF_ARTIFACTS_LIMIT, HANDOFF_BLOCKER_LIMIT,
  HANDOFF_FAILURE_SIGNATURE_LIMIT, HANDOFF_FILES_LIMIT, HANDOFF_HYPOTHESES_LIMIT,
  HANDOFF_HYPOTHESIS_LIMIT, HANDOFF_PATH_LIMIT, HANDOFF_STAGE_LIMIT, HANDOFF_SUMMARY_LIMIT,
  HANDOFF_VERIFICATION_COMMAND_LIMIT, HANDOFF_VERIFICATION_LIMIT, HANDOFF_VERIFICATION_SUMMARY_LIMIT,
  RECOVERY_CAPSULE_MAX_BYTES, TASK_PACKET_END, TASK_PACKET_START, UNCERTAIN_EFFECTS_LIMIT,
  type DshEvent, type EditWriteActivity, type Observation, type ProgressHeartbeat,
  taskPacketSchema, supervisorProgressSchema,
  recoveryCapsuleSchema,
  type ProjectActivity, type RecoveryCapsule, type SupervisorProgress, type TaskPacket, type TaskRuntimeState,
  type UncertainEffectLedger,
} from './contracts.js'

type HandoffTruncatedField = NonNullable<Observation['handoffTruncated']>['fields'][number]

function boundedHandoffString(
  value: unknown,
  limit: number,
  field: HandoffTruncatedField,
  truncated: Set<HandoffTruncatedField>,
): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length > limit) truncated.add(field)
  return value.slice(0, limit)
}

function boundedHandoffStrings(
  value: unknown,
  maxItems: number,
  maxLength: number,
  field: HandoffTruncatedField,
  truncated: Set<HandoffTruncatedField>,
): string[] {
  if (!Array.isArray(value)) return []
  if (value.length > maxItems || value.some(item => typeof item !== 'string' || item.length > maxLength)) truncated.add(field)
  return value.filter((item): item is string => typeof item === 'string')
    .slice(0, maxItems)
    .map(item => item.slice(0, maxLength))
}

function boundedHandoffVerification(
  value: unknown,
  truncated: Set<HandoffTruncatedField>,
): Observation['verification'] {
  if (!Array.isArray(value)) return []
  if (value.length > HANDOFF_VERIFICATION_LIMIT) truncated.add('verification')
  return value.slice(0, HANDOFF_VERIFICATION_LIMIT).flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      truncated.add('verification')
      return []
    }
    const entry = item as Record<string, unknown>
    if (typeof entry.command !== 'string' || typeof entry.summary !== 'string'
      || !['passed', 'failed', 'not_run'].includes(String(entry.outcome))) {
      truncated.add('verification')
      return []
    }
    if (entry.command.length > HANDOFF_VERIFICATION_COMMAND_LIMIT
      || entry.summary.length > HANDOFF_VERIFICATION_SUMMARY_LIMIT) truncated.add('verification')
    return [{
      command: entry.command.slice(0, HANDOFF_VERIFICATION_COMMAND_LIMIT),
      outcome: entry.outcome as 'passed' | 'failed' | 'not_run',
      summary: entry.summary.slice(0, HANDOFF_VERIFICATION_SUMMARY_LIMIT),
    }]
  })
}

function boundedHandoffArtifacts(
  value: unknown,
  truncated: Set<HandoffTruncatedField>,
): Observation['artifacts'] {
  if (!Array.isArray(value)) return []
  if (value.length > HANDOFF_ARTIFACTS_LIMIT) truncated.add('artifacts')
  return value.slice(0, HANDOFF_ARTIFACTS_LIMIT).flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      truncated.add('artifacts')
      return []
    }
    const entry = item as Record<string, unknown>
    if (typeof entry.path !== 'string' || typeof entry.bytes !== 'number'
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      truncated.add('artifacts')
      return []
    }
    if (entry.path.length > HANDOFF_ARTIFACT_PATH_LIMIT) truncated.add('artifacts')
    return [{ path: entry.path.slice(0, HANDOFF_ARTIFACT_PATH_LIMIT), bytes: entry.bytes, sha256: entry.sha256 }]
  })
}

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

function taskPacketTexts(event: DshEvent): string[] {
  if (event.type === 'user/message') return [eventText(event)]
  if (event.type !== 'agent/inbox/spliced') return []
  const inserted = (event.data as { inserted?: unknown }).inserted
  if (!Array.isArray(inserted)) return []
  return inserted.flatMap((message) => {
    if (typeof message !== 'object' || message === null) return []
    const content = (message as { content?: unknown }).content
    return [textBlocks(content)]
  })
}

function taskPacketBoundary(events: readonly DshEvent[]): { packet: TaskPacket; seq: number } | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event === undefined) continue
    for (const text of taskPacketTexts(event).reverse()) {
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
  }
  return undefined
}

export function parseTaskPacket(events: readonly DshEvent[]): TaskPacket | undefined {
  return taskPacketBoundary(events)?.packet
}

/** Every valid durable packet boundary, oldest first (used for stateless request reconciliation). */
export function taskPacketEntries(events: readonly DshEvent[]): Array<{ packet: TaskPacket; seq: number }> {
  return events.flatMap((event) => {
    if (event.type !== 'user/message' && event.type !== 'agent/inbox/spliced') return []
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

interface FoldToolCall {
  event: DshEvent
  callId: string
  name: string
  argumentsText: string
  turn?: number
  step?: number
}

type RuntimeToolOutcome = 'passed' | 'failed' | 'pending'

/** Normalize native calls and Code/PTC SDK sub-dispatches onto one durable fold surface. */
function foldToolCall(event: DshEvent): FoldToolCall | undefined {
  if (event.type === 'tool/call') {
    const data = event.data as { callId?: unknown; name?: unknown; arguments?: unknown; turn?: unknown; step?: unknown }
    if (typeof data.callId !== 'string' || typeof data.name !== 'string' || typeof data.arguments !== 'string') return undefined
    return {
      event, callId: data.callId, name: data.name, argumentsText: data.arguments,
      ...typeof data.turn === 'number' ? { turn: data.turn } : {},
      ...typeof data.step === 'number' ? { step: data.step } : {},
    }
  }
  if (event.type !== 'tool/code-dispatch-start') return undefined
  const data = event.data as { subCallId?: unknown; name?: unknown; arguments?: unknown }
  if (typeof data.subCallId !== 'string' || typeof data.name !== 'string') return undefined
  try {
    const argumentsText = JSON.stringify(data.arguments)
    return typeof argumentsText === 'string'
      ? { event, callId: data.subCallId, name: data.name, argumentsText }
      : undefined
  } catch {
    return undefined
  }
}

function foldToolResult(event: DshEvent): { callId: string; failed: boolean; outcome: RuntimeToolOutcome } | undefined {
  if (event.type === 'tool/result') {
    const data = event.data as {
      message?: { source?: { callId?: unknown }; content?: Array<{ type?: unknown; isError?: unknown }> }
      error?: unknown
    }
    const callId = data.message?.source?.callId
    if (typeof callId !== 'string') return undefined
    const resultBlock = data.message?.content?.find(block => block.type === 'tool-result')
    const failed = data.error !== undefined || resultBlock?.isError === true
    return {
      callId,
      failed,
      outcome: failed ? 'failed' : resultBlock?.isError === false ? 'passed' : 'pending',
    }
  }
  if (event.type !== 'tool/code-dispatch') return undefined
  const data = event.data as { subCallId?: unknown; isError?: unknown }
  return typeof data.subCallId === 'string' && typeof data.isError === 'boolean'
    ? { callId: data.subCallId, failed: data.isError, outcome: data.isError ? 'failed' : 'passed' }
    : undefined
}

function foldToolCalls(events: readonly DshEvent[], fromSeq = Number.NEGATIVE_INFINITY, toSeq = Number.POSITIVE_INFINITY): FoldToolCall[] {
  return events.flatMap((event) => {
    if (event.seq < fromSeq || event.seq > toSeq) return []
    const call = foldToolCall(event)
    return call === undefined ? [] : [call]
  })
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
const MAX_TOOL_NAME_LABEL = 64
const MAX_ACTIVITY_TOOL_NAMES = 32
const CLASSIFIED_NON_MUTATING_TOOLS = new Set([
  'read', 'view', 'grep', 'glob', 'find', 'ls',
  'run_code',
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

/** First correlated runtime outcome for each call id, indexed once per scope. */
function callOutcomes(events: readonly DshEvent[], fromSeq: number, toSeq: number): Map<string, RuntimeToolOutcome> {
  const outcomeById = new Map<string, RuntimeToolOutcome>()
  for (const event of events) {
    if (event.seq < fromSeq || event.seq > toSeq) continue
    const result = foldToolResult(event)
    if (result === undefined || outcomeById.has(result.callId)) continue
    outcomeById.set(result.callId, result.outcome)
  }
  return outcomeById
}

/**
 * Calls that may have crossed an effect boundary but have no durable correlated
 * tool/result. Arguments and outputs are deliberately excluded: the ledger is
 * evidence for reconciliation, not a replay recipe.
 */
export function uncertainEffectsIn(
  events: readonly DshEvent[],
  fromSeq: number,
  toSeq: number,
): UncertainEffectLedger {
  const durableResults = new Map<string, number>()
  for (const event of events) {
    if (event.seq < fromSeq || event.seq > toSeq) continue
    const result = foldToolResult(event)
    if (result !== undefined) durableResults.set(result.callId, Math.max(durableResults.get(result.callId) ?? -1, event.seq))
  }
  const allEntries: UncertainEffectLedger['entries'] = []
  let total = 0
  for (const call of foldToolCalls(events, fromSeq, toSeq)) {
    const rawCallId = call.callId
    if ((durableResults.get(call.callId) ?? -1) > call.event.seq) continue
    const toolName = cleanLabel(call.name, MAX_TOOL_NAME_LABEL) ?? 'unknown'
    if (CLASSIFIED_NON_MUTATING_TOOLS.has(toolName)) continue
    total += 1
    if (allEntries.length >= UNCERTAIN_EFFECTS_LIMIT) continue
    const callId = cleanLabel(rawCallId, 128) ?? `event-${String(call.event.seq)}`
    const step = typeof call.step === 'number' && Number.isInteger(call.step) && call.step >= 0
      ? call.step
      : undefined
    allEntries.push({
      callId,
      toolName,
      category: toolName in MUTATING_TOOLS
        ? 'FILESYSTEM_MUTATION'
        : toolName === 'bash'
          ? 'COMMAND_OR_EXTERNAL_EFFECT'
          : 'UNKNOWN_TOOL_EFFECT',
      callSeq: call.event.seq,
      ...step === undefined ? {} : { step },
      reason: 'NO_DURABLE_TOOL_RESULT',
      replayGuidance: 'RECONCILE_BEFORE_RETRY',
    })
  }
  return {
    source: 'DURABLE_EVENT_FOLD',
    total,
    entries: allEntries,
    truncated: total > allEntries.length,
  }
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
    }
  }
  for (const call of foldToolCalls(events, fromSeq, toSeq)) {
    toolCalls += 1
    const rawName = call.name
    const name = cleanLabel(rawName, MAX_TOOL_NAME_LABEL) ?? 'unknown'
    if (name in toolCallsByName || Object.keys(toolCallsByName).length < MAX_ACTIVITY_TOOL_NAMES) {
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1
    } else {
      coverage = 'partial'
    }
    if (!(name in MUTATING_TOOLS) && !CLASSIFIED_NON_MUTATING_TOOLS.has(name)) coverage = 'partial'
    const outcome = outcomes.get(call.callId)
    if (outcome === 'passed') {
      const path = mutatingFilePath(name, call.argumentsText, workspaceCwd)
      if (path !== undefined) editFiles.add(path)
    }
    const command = verificationCommandLabel(name, call.argumentsText)
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
  const data = event.data as {
    step?: unknown; name?: unknown; callId?: unknown; subCallId?: unknown
    message?: { source?: { callId?: unknown } }
  }
  const step = typeof data.step === 'number' && Number.isInteger(data.step) && data.step >= 0 ? data.step : undefined
  const common = { seq: event.seq, time: event.time, ...step === undefined ? {} : { step } }
  switch (event.type) {
    case 'turn/start':
    case 'turn/end': return { ...common, kind: 'turn' }
    case 'step/start':
    case 'step/end': return { ...common, kind: 'step' }
    case 'assistant/chunk': return { ...common, kind: 'model_stream' }
    case 'assistant/message': return { ...common, kind: 'model_message' }
    case 'tool/call':
    case 'tool/code-dispatch-start': return {
      ...common,
      kind: 'tool_call',
      ...typeof data.name === 'string' ? { toolName: data.name.slice(0, MAX_TOOL_NAME_LABEL) } : {},
    }
    case 'tool/result':
    case 'tool/code-dispatch': {
      const callId = event.type === 'tool/result' ? data.message?.source?.callId : data.subCallId
      const toolName = typeof callId === 'string' ? toolNames.get(callId) : undefined
      return { ...common, kind: 'tool_result', ...toolName === undefined ? {} : { toolName: toolName.slice(0, MAX_TOOL_NAME_LABEL) } }
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
  const toolCalls = foldToolCalls(scoped)
  for (const call of toolCalls) toolNames.set(call.callId, call.name)
  const deltaToolCalls = toolCalls.filter(call => call.event.seq > fromAsOfSeq)
  const deltaByName: Record<string, number> = {}
  for (const call of deltaToolCalls) {
    const key = call.name.slice(0, MAX_TOOL_NAME_LABEL)
    if (key in deltaByName || Object.keys(deltaByName).length < MAX_ACTIVITY_TOOL_NAMES) {
      deltaByName[key] = (deltaByName[key] ?? 0) + 1
    }
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
    if (event.seq >= beforeSeq) return false
    const result = foldToolResult(event)
    return result?.callId === callId && !result.failed
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
  const calls = foldToolCalls(events, boundarySeq).filter(call => call.name === 'supervisor_progress')
  const records: Array<{ progress: SupervisorProgress; seq: number }> = []
  for (const call of calls) {
    const result = toolResultFor(events, call.callId, Number.POSITIVE_INFINITY)
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

function toolCallsInTurn(events: readonly DshEvent[], turnEnd: DshEvent, name: string): FoldToolCall[] {
  const turn = (turnEnd.data as { turn?: unknown }).turn
  const start = events.findLast((event) => event.type === 'turn/start' && event.seq < turnEnd.seq
    && (event.data as { turn?: unknown }).turn === turn)
  const fromSeq = start?.seq ?? Number.NEGATIVE_INFINITY
  return foldToolCalls(events, fromSeq, turnEnd.seq - 1).filter(call =>
    call.name === name && (call.turn === undefined || call.turn === turn))
}

export interface RecoveryCapsuleScope {
  sessionId: string
  events: readonly DshEvent[]
  activationSeq: number
  terminalSeq: number
  cwd?: string | undefined
}

function mergedRecoveryEvidence(scopes: readonly RecoveryCapsuleScope[]): {
  activity: ProjectActivity
  uncertainEffects: UncertainEffectLedger
} {
  const activities = scopes.map(scope => projectActivityIn(
    scope.events, scope.activationSeq, scope.terminalSeq, scope.cwd,
  ))
  const editFiles = new Set<string>()
  const verification = new Map<string, 'passed' | 'failed' | 'pending'>()
  const toolCallsByName: Record<string, number> = {}
  const tokenUsage = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  let coverage: 'complete' | 'partial' = 'complete'
  let editsTotal = 0
  let verificationTotal = 0
  let steps = 0
  let toolCalls = 0
  for (const activity of activities) {
    if (activity.coverage === 'partial') coverage = 'partial'
    editsTotal += activity.edits.total
    for (const path of activity.edits.files) editFiles.add(path)
    verificationTotal += activity.verification.total
    for (const entry of activity.verification.evidence) {
      const previous = verification.get(entry.command)
      const rank = { passed: 0, pending: 1, failed: 2 } as const
      if (previous === undefined || rank[entry.outcome] > rank[previous]) verification.set(entry.command, entry.outcome)
    }
    steps += activity.steps
    toolCalls += activity.toolCalls
    for (const [name, count] of Object.entries(activity.toolCallsByName)) {
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + count
    }
    tokenUsage.uncachedInputTokens += activity.tokenUsage.uncachedInputTokens
    tokenUsage.outputTokens += activity.tokenUsage.outputTokens
    tokenUsage.cacheReadTokens += activity.tokenUsage.cacheReadTokens
    tokenUsage.cacheWriteTokens += activity.tokenUsage.cacheWriteTokens
  }
  const boundedToolNames = Object.entries(toolCallsByName).sort(([left], [right]) => left.localeCompare(right)).slice(0, 12)
  if (boundedToolNames.length < Object.keys(toolCallsByName).length) coverage = 'partial'

  const ledgers = scopes.map(scope => ({
    sessionId: scope.sessionId,
    ledger: uncertainEffectsIn(scope.events, scope.activationSeq, scope.terminalSeq),
  }))
  const totalEffects = ledgers.reduce((total, entry) => total + entry.ledger.total, 0)
  const effectEntries = ledgers.flatMap(({ sessionId, ledger }) =>
    ledger.entries.map(entry => ({ ...entry, sessionId }))).slice(0, UNCERTAIN_EFFECTS_LIMIT)
  return {
    activity: {
      coverage,
      edits: { total: editsTotal, files: [...editFiles].sort().slice(0, 8) },
      verification: {
        total: verificationTotal,
        commands: [...verification.keys()].sort().slice(0, 4),
        evidence: [...verification.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, 4)
          .map(([command, outcome]) => ({ command, outcome })),
      },
      steps,
      toolCalls,
      toolCallsByName: Object.fromEntries(boundedToolNames),
      tokenUsage,
    },
    uncertainEffects: {
      source: 'DURABLE_EVENT_FOLD',
      total: totalEffects,
      entries: effectEntries,
      truncated: ledgers.some(entry => entry.ledger.truncated) || totalEffects > effectEntries.length,
    },
  }
}

export function recoveryCapsuleForRunTree(
  state: TaskRuntimeState,
  packet: Extract<TaskPacket, { schemaVersion: 2 }>,
  turnEnd: DshEvent,
  childScopes: readonly RecoveryCapsuleScope[] = [],
): RecoveryCapsule {
  const packetSeq = taskBoundarySeq(state.events) ?? -1
  const scopes: RecoveryCapsuleScope[] = [{
    sessionId: packet.sessionId,
    events: state.events,
    activationSeq: packetSeq,
    terminalSeq: turnEnd.seq,
    cwd: state.cwd,
  }, ...childScopes].sort((left, right) => {
    if (left.sessionId === packet.sessionId) return -1
    if (right.sessionId === packet.sessionId) return 1
    return left.sessionId.localeCompare(right.sessionId)
  })
  const { activity, uncertainEffects } = mergedRecoveryEvidence(scopes)
  const progress = latestSupervisorProgress(state.events, packet)?.progress
  const objective = packet.objective.slice(0, 1_024)
  const baselineStatus = packet.baseline?.statusSummary.slice(0, 1_024)
  const toolCallsByName = Object.fromEntries(Object.entries(activity.toolCallsByName).slice(0, 12))
  const observedTokens = activity.tokenUsage.uncachedInputTokens + activity.tokenUsage.outputTokens
    + activity.tokenUsage.cacheReadTokens + activity.tokenUsage.cacheWriteTokens
  const body: Omit<RecoveryCapsule, 'byteLength'> = {
    schemaVersion: 1,
    source: 'DURABLE_EVENT_FOLD',
    modelCallsUsed: 0,
    maxBytes: RECOVERY_CAPSULE_MAX_BYTES,
    parentRunId: packet.runId,
    objective,
    objectiveTruncated: objective.length < packet.objective.length,
    interruption: {
      kind: 'HOST_RESTART_INTERRUPTED',
      boundarySeq: turnEnd.seq,
      asOfSeq: turnEnd.seq,
    },
    runTree: {
      coverage: 'complete',
      totalSessions: scopes.length,
      sessions: scopes.map(scope => ({
        sessionId: scope.sessionId,
        activationSeq: scope.activationSeq,
        terminalSeq: scope.terminalSeq,
      })),
    },
    ...progress === undefined ? {} : { lastAcceptedProgress: {
      phase: progress.phase,
      milestone: progress.milestone.slice(0, 512),
      nextAction: progress.nextAction.slice(0, 512),
      ...progress.currentHypothesis === undefined ? {} : { currentHypothesis: progress.currentHypothesis.slice(0, 512) },
      ...progress.risk === undefined ? {} : { risk: progress.risk.slice(0, 256) },
    } },
    workspace: {
      ...packet.baseline === undefined || baselineStatus === undefined ? {} : { baseline: {
        ...packet.baseline.head === undefined ? {} : { head: packet.baseline.head.slice(0, 128) },
        statusSummary: baselineStatus,
        truncated: baselineStatus.length < packet.baseline.statusSummary.length
          || (packet.baseline.head?.length ?? 0) > 128,
      } },
      activity: {
        coverage: activity.coverage,
        edits: {
          total: activity.edits.total,
          files: activity.edits.files.slice(0, 8).map(path => path.slice(0, 160)),
        },
        verification: {
          total: activity.verification.total,
          evidence: activity.verification.evidence.slice(0, 4),
        },
        steps: activity.steps,
        toolCalls: activity.toolCalls,
        toolCallsByName,
        tokenUsage: activity.tokenUsage,
      },
    },
    ...packet.budget === undefined ? {} : { budget: {
      limitTokens: packet.budget.maxTokens,
      observedTokens,
      remainingTokens: Math.max(0, packet.budget.maxTokens - observedTokens),
      exhausted: observedTokens >= packet.budget.maxTokens,
    } },
    uncertainEffects,
    continuation: {
      action: uncertainEffects.total === 0
        ? 'CONTINUE_FROM_DURABLE_EVIDENCE'
        : 'RECONCILE_UNCERTAIN_EFFECTS_THEN_CONTINUE',
      replayPolicy: 'DO_NOT_BLINDLY_REPLAY',
      evidenceOnly: true,
    },
  }
  let byteLength = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = Buffer.byteLength(JSON.stringify({ ...body, byteLength }), 'utf8')
    if (next === byteLength) break
    byteLength = next
  }
  return recoveryCapsuleSchema.parse({ ...body, byteLength })
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
  const calls = toolCallsInTurn(state.events, turnEnd, 'supervisor_handoff').reverse()
  for (const call of calls) {
    let args: Record<string, unknown>
    try { args = JSON.parse(call.argumentsText) as Record<string, unknown> } catch { continue }
    const result = toolResultFor(state.events, call.callId, turnEnd.seq)
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
    const truncated = new Set<HandoffTruncatedField>()
    const stage = boundedHandoffString(handoff.stage, HANDOFF_STAGE_LIMIT, 'stage', truncated) ?? 'unknown'
    const summary = boundedHandoffString(handoff.summary, HANDOFF_SUMMARY_LIMIT, 'summary', truncated) ?? ''
    const files = boundedHandoffStrings(
      handoff.files, HANDOFF_FILES_LIMIT, HANDOFF_PATH_LIMIT, 'files', truncated,
    )
    const verification = boundedHandoffVerification(handoff.verification, truncated)
    const artifacts = boundedHandoffArtifacts(output.artifacts, truncated)
    const blocker = boundedHandoffString(handoff.blocker, HANDOFF_BLOCKER_LIMIT, 'blocker', truncated)
    const failureSignature = boundedHandoffString(
      handoff.failureSignature, HANDOFF_FAILURE_SIGNATURE_LIMIT, 'failureSignature', truncated,
    )
    const attemptedHypotheses = Array.isArray(handoff.attemptedHypotheses)
      ? boundedHandoffStrings(
        handoff.attemptedHypotheses, HANDOFF_HYPOTHESES_LIMIT, HANDOFF_HYPOTHESIS_LIMIT,
        'attemptedHypotheses', truncated,
      )
      : undefined
    const common = {
      ...base(state, packet),
      boundarySeq: turnEnd.seq,
      stage,
      summary,
      files,
      verification,
      artifacts,
      projectActivity: projectActivityIn(state.events, state.events.at(0)?.seq ?? turnEnd.seq, turnEnd.seq, state.cwd),
      ...blocker === undefined ? {} : { blocker },
      ...failureSignature === undefined ? {} : { failureSignature },
      ...attemptedHypotheses === undefined ? {} : { attemptedHypotheses },
      ...truncated.size === 0 ? {} : { handoffTruncated: { fields: [...truncated] } },
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
  const calls = toolCallsInTurn(state.events, turnEnd, 'supervisor_report_failure').reverse()
  for (const call of calls) {
    const result = toolResultFor(state.events, call.callId, turnEnd.seq)
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
      ...typeof output.failureSignature === 'string'
        ? { failureSignature: output.failureSignature.slice(0, HANDOFF_FAILURE_SIGNATURE_LIMIT) }
        : {},
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
  const requestRejected = /^dsh-gate:token-budget-request-rejected;/.test(text)
  const accountingFailed = /^dsh-gate:token-budget-accounting-failed;/.test(text)
  if (!exhausted && !requestRejected && !accountingFailed) return undefined
  const fields = new Map(text.split(';').slice(1).flatMap(part => {
    const separator = part.indexOf('=')
    return separator < 0 ? [] : [[part.slice(0, separator), part.slice(separator + 1)] as const]
  }))
  const used = Number(fields.get('used'))
  const limit = Number(fields.get('limit'))
  const remaining = Number(fields.get('remaining'))
  const requiredInput = Number(fields.get('requiredInput'))
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
  const remainingTokens = requestRejected && Number.isSafeInteger(remaining) && remaining >= 0
    ? remaining
    : 0
  return {
    ...common,
    status: 'ESCALATION_REQUIRED',
    stage: requestRejected ? 'token-budget-request-rejected' : 'token-budget-exhausted',
    summary: requestRejected
      ? `The next model request could not fit within the Host-enforced task token budget (${observedTokens}/${limitTokens} used, ${remainingTokens} remaining${Number.isSafeInteger(requiredInput) && requiredInput > 0 ? `, ${requiredInput} input tokens required` : ''}).`
      : `Host-enforced task token budget exhausted (${observedTokens}/${limitTokens}).`,
    budget: {
      limitTokens,
      observedTokens,
      remainingTokens,
      exhausted: !requestRejected,
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
    failure: { kind: 'HOST_FAILED', message: state.hostError.slice(0, 2_048), retryable: true },
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
