import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

export const RECOVERY_CAPSULE_MAX_BYTES = 16_384
/** Wire-protocol bound; keep aligned with @dsh-gate/mcp-server contracts schema v1. */
export const UNCERTAIN_EFFECTS_LIMIT = 16

export interface RecoveryEvent {
  type: string
  seq: number
  time?: number
  data: unknown
}

export interface RecoveryScope {
  sessionId: string
  events: readonly RecoveryEvent[]
  activationSeq: number
  terminalSeq: number
  cwd?: string
}

export interface RecoveryTaskPacket {
  schemaVersion: 2
  sessionId: string
  runId: string
  objective: string
  baseline?: { head?: string; statusSummary: string }
  budget?: { maxTokens: number }
}

export interface RecoveryCapsule {
  schemaVersion: 1
  source: 'DURABLE_EVENT_FOLD'
  modelCallsUsed: 0
  maxBytes: typeof RECOVERY_CAPSULE_MAX_BYTES
  byteLength: number
  parentRunId: string
  objective: string
  objectiveTruncated: boolean
  interruption: {
    kind: 'HOST_RESTART_INTERRUPTED'
    boundarySeq: number
    asOfSeq: number
  }
  runTree: {
    coverage: 'complete'
    totalSessions: number
    sessions: Array<{ sessionId: string; activationSeq: number; terminalSeq: number }>
  }
  lastAcceptedProgress?: {
    phase: 'investigating' | 'implementing' | 'verifying' | 'recovering'
    milestone: string
    nextAction: string
    currentHypothesis?: string
    risk?: string
  }
  workspace: {
    baseline?: { head?: string; statusSummary: string; truncated: boolean }
    activity: ProjectActivity
  }
  budget?: { limitTokens: number; observedTokens: number; remainingTokens: number; exhausted: boolean }
  uncertainEffects: UncertainEffectLedger
  continuation: {
    action: 'CONTINUE_FROM_DURABLE_EVIDENCE' | 'RECONCILE_UNCERTAIN_EFFECTS_THEN_CONTINUE'
    replayPolicy: 'DO_NOT_BLINDLY_REPLAY'
    evidenceOnly: true
  }
}

interface TokenBuckets {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface ProjectActivity {
  coverage: 'complete' | 'partial'
  edits: { total: number; files: string[] }
  verification: {
    total: number
    evidence: Array<{ command: string; outcome: 'passed' | 'failed' | 'pending' }>
  }
  steps: number
  toolCalls: number
  toolCallsByName: Record<string, number>
  tokenUsage: TokenBuckets
}

interface UncertainEffectLedger {
  source: 'DURABLE_EVENT_FOLD'
  total: number
  entries: Array<{
    sessionId?: string
    callId: string
    toolName: string
    category: 'FILESYSTEM_MUTATION' | 'COMMAND_OR_EXTERNAL_EFFECT' | 'UNKNOWN_TOOL_EFFECT'
    callSeq: number
    step?: number
    reason: 'NO_DURABLE_TOOL_RESULT'
    replayGuidance: 'RECONCILE_BEFORE_RETRY'
  }>
  truncated: boolean
}

const TASK_PACKET_START = '<dsh-supervised-task>'
const TASK_PACKET_END = '</dsh-supervised-task>'
const MUTATING_TOOLS: Record<string, { pathKey: string; mutatingCommands?: ReadonlySet<string> }> = {
  edit: { pathKey: 'file_path' },
  write: { pathKey: 'file_path' },
  str_replace_editor: { pathKey: 'path', mutatingCommands: new Set(['create', 'str_replace', 'insert']) },
}
const CLASSIFIED_NON_MUTATING_TOOLS = new Set([
  'read', 'view', 'grep', 'glob', 'find', 'ls',
  'supervisor_progress', 'supervisor_handoff', 'supervisor_report_failure',
])
const VERIFICATION_TOKENS = new Set([
  'pnpm', 'npm', 'yarn', 'npx', 'bun', 'deno', 'tsc', 'vitest', 'jest', 'mocha',
  'eslint', 'prettier', 'make', 'gradle', 'mvn', 'ant', 'cargo', 'go', 'dotnet',
  'pytest', 'mypy', 'ruff',
])
const VERIFICATION_ACTIONS = new Set(['build', 'check', 'lint', 'pack', 'run', 'test', 'typecheck', 'verify'])

function cleanLabel(value: string, max: number): string | undefined {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return cleaned === '' ? undefined : cleaned.slice(0, max)
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const value = block as { type?: unknown; text?: unknown; content?: unknown }
    if (value.type === 'text' && typeof value.text === 'string') return [value.text]
    if (value.type === 'tool-result') return [textBlocks(value.content)]
    return []
  }).join('\n')
}

function eventText(event: RecoveryEvent): string {
  const data = event.data as { content?: unknown; message?: { content?: unknown } }
  return textBlocks(data.content ?? data.message?.content)
}

function taskPacketIn(event: RecoveryEvent): Record<string, unknown> | undefined {
  const texts = event.type === 'user/message'
    ? [eventText(event)]
    : event.type === 'agent/inbox/spliced' && Array.isArray((event.data as { inserted?: unknown }).inserted)
      ? ((event.data as { inserted: Array<{ content?: unknown }> }).inserted).map(message => textBlocks(message.content))
      : []
  for (const text of texts.reverse()) {
    const end = text.lastIndexOf(TASK_PACKET_END)
    if (end < 0) continue
    let before = end
    while (before >= 0) {
      const start = text.lastIndexOf(TASK_PACKET_START, before)
      if (start < 0) break
      try {
        const parsed = JSON.parse(text.slice(start + TASK_PACKET_START.length, end).trim()) as unknown
        if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
      } catch { /* Try an earlier marker. */ }
      before = start - 1
    }
  }
  return undefined
}

export function affiliatedChildActivation(
  events: readonly RecoveryEvent[],
  childSessionId: string,
  rootBoundaryTime: number,
  runId: string,
): RecoveryEvent | undefined {
  const nested = [...events].reverse().find((event) => {
    if ((event.time ?? -1) < rootBoundaryTime) return false
    const packet = taskPacketIn(event)
    return packet?.schemaVersion === 2 && packet.sessionId === childSessionId
  })
  const nestedPacket = nested === undefined ? undefined : taskPacketIn(nested)
  if (nestedPacket?.runId !== undefined && nestedPacket.runId !== runId) return undefined
  return events.find((event) => {
    if (event.type !== 'user/message' || (event.time ?? -1) < rootBoundaryTime) return false
    const packet = taskPacketIn(event)
    return packet === undefined || (packet.schemaVersion === 2
      && packet.sessionId === childSessionId && packet.runId === runId)
  })
}

function projectRelativePath(cwd: string | undefined, raw: string): string | undefined {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (cleaned === '' || cleaned.length > 4_096) return undefined
  if (cwd === undefined) {
    if (isAbsolute(cleaned)) return undefined
    const normalized = normalize(cleaned)
    if (normalized === '..' || normalized.startsWith(`..${sep}`)) return undefined
    return cleanLabel(normalized, 160)
  }
  const target = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned)
  const suffix = relative(cwd, target)
  if (suffix === '' || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) return undefined
  return cleanLabel(suffix, 160)
}

function callOutcomes(events: readonly RecoveryEvent[], fromSeq: number, toSeq: number): Map<string, 'passed' | 'failed' | 'pending'> {
  const outcomes = new Map<string, 'passed' | 'failed' | 'pending'>()
  for (const event of events) {
    if (event.seq < fromSeq || event.seq > toSeq || event.type !== 'tool/result') continue
    const data = event.data as {
      message?: { source?: { callId?: unknown }; content?: Array<{ type?: unknown; isError?: unknown }> }
      error?: unknown
    }
    const callId = data.message?.source?.callId
    if (typeof callId !== 'string' || outcomes.has(callId)) continue
    const block = data.message?.content?.find(candidate => candidate.type === 'tool-result')
    outcomes.set(callId, data.error !== undefined || block?.isError === true
      ? 'failed' : block?.isError === false ? 'passed' : 'pending')
  }
  return outcomes
}

function tokenNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function tokensAt(events: readonly RecoveryEvent[], asOfSeq: number): TokenBuckets {
  const samples = new Map<string, TokenBuckets>()
  for (const event of events) {
    if (event.seq > asOfSeq) break
    const data = event.data as { turn?: unknown; step?: unknown; chunk?: unknown; usage?: unknown }
    if (typeof data.turn !== 'number' || typeof data.step !== 'number') continue
    const usage = event.type === 'assistant/chunk'
      && typeof data.chunk === 'object' && data.chunk !== null
      && (data.chunk as { type?: unknown }).type === 'usage'
      ? (data.chunk as { usage?: unknown }).usage
      : event.type === 'assistant/message' ? data.usage : undefined
    if (typeof usage !== 'object' || usage === null) continue
    const value = usage as Record<string, unknown>
    const input = tokenNumber(value.inputTokens)
    const output = tokenNumber(value.outputTokens)
    if (input === undefined || output === undefined) continue
    samples.set(`${String(data.turn)}:${String(data.step)}`, {
      uncachedInputTokens: input,
      outputTokens: output,
      cacheReadTokens: tokenNumber(value.cacheReadTokens) ?? 0,
      cacheWriteTokens: tokenNumber(value.cacheWriteTokens) ?? 0,
    })
  }
  const total = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const sample of samples.values()) {
    total.uncachedInputTokens += sample.uncachedInputTokens
    total.outputTokens += sample.outputTokens
    total.cacheReadTokens += sample.cacheReadTokens
    total.cacheWriteTokens += sample.cacheWriteTokens
  }
  return total
}

function tokenDelta(events: readonly RecoveryEvent[], fromSeq: number, toSeq: number): TokenBuckets {
  const before = tokensAt(events, fromSeq)
  const after = tokensAt(events, toSeq)
  return {
    uncachedInputTokens: after.uncachedInputTokens - before.uncachedInputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    cacheReadTokens: after.cacheReadTokens - before.cacheReadTokens,
    cacheWriteTokens: after.cacheWriteTokens - before.cacheWriteTokens,
  }
}

function verificationCommandLabels(command: string): string[] {
  const labels = new Set<string>()
  for (const segment of command.split(/&&|\n/)) {
    if (/\|\||(?<!\|)\|(?!\|)/.test(segment)) continue
    const tokens = segment.trim().split(/\s+/)
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift()
    const first = tokens[0]?.toLowerCase()
    if (first === undefined) continue
    let label: string | undefined
    if (first === 'test') {
      const flag = tokens[1]?.toLowerCase()
      label = flag === '-e' || flag === '-f' || flag === '-s' ? `test ${flag}` : 'test'
    } else if (first === 'git' && tokens[1]?.toLowerCase() === 'diff' && tokens.includes('--check')) {
      label = 'git diff --check'
    } else if (VERIFICATION_TOKENS.has(first)) {
      const action = tokens.slice(1).map(token => token.toLowerCase())
        .find(token => VERIFICATION_ACTIONS.has(token))
      label = action === undefined ? first : `${first} ${action}`
    }
    const cleaned = label === undefined ? undefined : cleanLabel(label, 60)
    if (cleaned !== undefined) labels.add(cleaned)
  }
  return [...labels]
}

function workspaceChangesFromResult(event: RecoveryEvent | undefined): {
  total: number
  files: string[]
  truncated: boolean
} | undefined {
  if (event === undefined) return undefined
  try {
    const parsed = JSON.parse(eventText(event)) as { workspaceChanges?: unknown }
    if (typeof parsed.workspaceChanges !== 'object' || parsed.workspaceChanges === null) return undefined
    const raw = parsed.workspaceChanges as Record<string, unknown>
    if (raw.source !== 'HOST_GIT_BASELINE' || !Number.isInteger(raw.total) || (raw.total as number) < 0
      || !Array.isArray(raw.files) || typeof raw.truncated !== 'boolean') return undefined
    const files = raw.files.filter((path): path is string => typeof path === 'string')
      .map(path => projectRelativePath(undefined, path)).filter((path): path is string => path !== undefined)
    return {
      total: raw.total as number,
      files,
      truncated: raw.truncated || files.length < raw.files.length,
    }
  } catch {
    return undefined
  }
}

function projectActivity(scope: RecoveryScope): ProjectActivity {
  const outcomes = callOutcomes(scope.events, scope.activationSeq, scope.terminalSeq)
  const results = new Map<string, RecoveryEvent>()
  for (const event of scope.events) {
    if (event.seq < scope.activationSeq || event.seq > scope.terminalSeq || event.type !== 'tool/result') continue
    const callId = (event.data as { message?: { source?: { callId?: unknown } } }).message?.source?.callId
    if (typeof callId === 'string') results.set(callId, event)
  }
  const files = new Set<string>()
  const verification = new Map<string, 'passed' | 'failed' | 'pending'>()
  const toolCallsByName: Record<string, number> = {}
  let coverage: 'complete' | 'partial' = 'complete'
  let authoritativeEditTotal = 0
  let steps = 0
  let toolCalls = 0
  for (const event of scope.events) {
    if (event.seq < scope.activationSeq || event.seq > scope.terminalSeq) continue
    if (event.type === 'step/end') { steps++; continue }
    if (event.type !== 'tool/call') continue
    toolCalls++
    const data = event.data as { name?: unknown; arguments?: unknown; callId?: unknown }
    const name = cleanLabel(typeof data.name === 'string' ? data.name : 'unknown', 64) ?? 'unknown'
    if (name in toolCallsByName || Object.keys(toolCallsByName).length < 32) {
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1
    } else coverage = 'partial'
    if (!(name in MUTATING_TOOLS) && !CLASSIFIED_NON_MUTATING_TOOLS.has(name)) coverage = 'partial'
    if (typeof data.arguments !== 'string') { coverage = 'partial'; continue }
    const outcome = typeof data.callId === 'string' ? outcomes.get(data.callId) : undefined
    const spec = MUTATING_TOOLS[name]
    if (outcome === 'passed' && spec !== undefined) {
      try {
        const args = JSON.parse(data.arguments) as Record<string, unknown>
        const command = args.command
        if (spec.mutatingCommands === undefined
          || (typeof command === 'string' && spec.mutatingCommands.has(command))) {
          const raw = args[spec.pathKey]
          const path = typeof raw === 'string' ? projectRelativePath(scope.cwd, raw) : undefined
          if (path !== undefined) files.add(path)
        }
      } catch { coverage = 'partial' }
    }
    if (name === 'bash') {
      try {
        const command = (JSON.parse(data.arguments) as Record<string, unknown>).command
        if (typeof command === 'string') {
          for (const label of verificationCommandLabels(command)) verification.set(label, outcome ?? 'pending')
        }
      } catch { coverage = 'partial' }
    }
    if ((name === 'supervisor_progress' || name === 'supervisor_handoff') && typeof data.callId === 'string') {
      const evidence = workspaceChangesFromResult(results.get(data.callId))
      if (evidence !== undefined) {
        authoritativeEditTotal = Math.max(authoritativeEditTotal, evidence.total)
        for (const path of evidence.files) files.add(path)
        if (evidence.truncated) coverage = 'partial'
      }
    }
  }
  return {
    coverage,
    edits: { total: Math.max(files.size, authoritativeEditTotal), files: [...files].sort().slice(0, 8) },
    verification: {
      total: verification.size,
      evidence: [...verification.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, 4)
        .map(([command, outcome]) => ({ command, outcome })),
    },
    steps,
    toolCalls,
    toolCallsByName,
    tokenUsage: tokenDelta(scope.events, scope.activationSeq, scope.terminalSeq),
  }
}

function uncertainEffects(scope: RecoveryScope): UncertainEffectLedger {
  const results = new Map<string, number>()
  for (const event of scope.events) {
    if (event.seq < scope.activationSeq || event.seq > scope.terminalSeq || event.type !== 'tool/result') continue
    const callId = (event.data as { message?: { source?: { callId?: unknown } } }).message?.source?.callId
    if (typeof callId === 'string') results.set(callId, Math.max(results.get(callId) ?? -1, event.seq))
  }
  const entries: UncertainEffectLedger['entries'] = []
  let total = 0
  for (const event of scope.events) {
    if (event.seq < scope.activationSeq || event.seq > scope.terminalSeq || event.type !== 'tool/call') continue
    const data = event.data as { callId?: unknown; name?: unknown; step?: unknown }
    if (typeof data.callId === 'string' && (results.get(data.callId) ?? -1) > event.seq) continue
    const toolName = cleanLabel(typeof data.name === 'string' ? data.name : 'unknown', 64) ?? 'unknown'
    if (CLASSIFIED_NON_MUTATING_TOOLS.has(toolName)) continue
    total++
    if (entries.length >= UNCERTAIN_EFFECTS_LIMIT) continue
    entries.push({
      sessionId: scope.sessionId,
      callId: cleanLabel(typeof data.callId === 'string' ? data.callId : `event-${String(event.seq)}`, 128)
        ?? `event-${String(event.seq)}`,
      toolName,
      category: toolName in MUTATING_TOOLS ? 'FILESYSTEM_MUTATION'
        : toolName === 'bash' ? 'COMMAND_OR_EXTERNAL_EFFECT' : 'UNKNOWN_TOOL_EFFECT',
      callSeq: event.seq,
      ...typeof data.step === 'number' && Number.isInteger(data.step) && data.step >= 0 ? { step: data.step } : {},
      reason: 'NO_DURABLE_TOOL_RESULT',
      replayGuidance: 'RECONCILE_BEFORE_RETRY',
    })
  }
  return { source: 'DURABLE_EVENT_FOLD', total, entries, truncated: total > entries.length }
}

function acceptedProgress(root: RecoveryScope, packet: RecoveryTaskPacket): RecoveryCapsule['lastAcceptedProgress'] {
  const calls = root.events.filter(event => event.type === 'tool/call' && event.seq >= root.activationSeq
    && (event.data as { name?: unknown }).name === 'supervisor_progress')
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index]
    const callId = (call?.data as { callId?: unknown }).callId
    if (typeof callId !== 'string') continue
    const result = root.events.findLast(event => event.type === 'tool/result' && event.seq <= root.terminalSeq
      && (event.data as { message?: { source?: { callId?: unknown } } }).message?.source?.callId === callId)
    if (result === undefined) continue
    try {
      const parsed = JSON.parse(eventText(result)) as { accepted?: unknown; progress?: Record<string, unknown> }
      const value = parsed.progress
      if (parsed.accepted !== true || value?.sessionId !== packet.sessionId || value.runId !== packet.runId
        || !['investigating', 'implementing', 'verifying', 'recovering'].includes(String(value.phase))
        || typeof value.milestone !== 'string' || typeof value.nextAction !== 'string') continue
      return {
        phase: value.phase as NonNullable<RecoveryCapsule['lastAcceptedProgress']>['phase'],
        milestone: value.milestone.slice(0, 512),
        nextAction: value.nextAction.slice(0, 512),
        ...typeof value.currentHypothesis === 'string' ? { currentHypothesis: value.currentHypothesis.slice(0, 512) } : {},
        ...typeof value.risk === 'string' ? { risk: value.risk.slice(0, 256) } : {},
      }
    } catch { /* Ignore malformed tool output. */ }
  }
  return undefined
}

function mergedActivity(scopes: readonly RecoveryScope[]): ProjectActivity {
  const activities = scopes.map(projectActivity)
  const files = new Set<string>()
  const verification = new Map<string, 'passed' | 'failed' | 'pending'>()
  const toolCallsByName: Record<string, number> = {}
  const tokens = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let coverage: 'complete' | 'partial' = 'complete'
  let editsTotal = 0
  let steps = 0
  let toolCalls = 0
  for (const activity of activities) {
    if (activity.coverage === 'partial') coverage = 'partial'
    editsTotal += activity.edits.total
    for (const file of activity.edits.files) files.add(file)
    for (const entry of activity.verification.evidence) {
      const rank = { passed: 0, pending: 1, failed: 2 } as const
      const previous = verification.get(entry.command)
      if (previous === undefined || rank[entry.outcome] > rank[previous]) verification.set(entry.command, entry.outcome)
    }
    steps += activity.steps
    toolCalls += activity.toolCalls
    for (const [name, count] of Object.entries(activity.toolCallsByName)) {
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + count
    }
    tokens.uncachedInputTokens += activity.tokenUsage.uncachedInputTokens
    tokens.outputTokens += activity.tokenUsage.outputTokens
    tokens.cacheReadTokens += activity.tokenUsage.cacheReadTokens
    tokens.cacheWriteTokens += activity.tokenUsage.cacheWriteTokens
  }
  const toolNames = Object.entries(toolCallsByName).sort(([left], [right]) => left.localeCompare(right)).slice(0, 12)
  if (toolNames.length < Object.keys(toolCallsByName).length) coverage = 'partial'
  return {
    coverage,
    edits: { total: Math.max(files.size, editsTotal), files: [...files].sort().slice(0, 8) },
    verification: {
      total: verification.size,
      evidence: [...verification.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, 4)
        .map(([command, outcome]) => ({ command, outcome })),
    },
    steps,
    toolCalls,
    toolCallsByName: Object.fromEntries(toolNames),
    tokenUsage: tokens,
  }
}

export function buildRecoveryCapsule(
  packet: RecoveryTaskPacket,
  scopesInput: readonly RecoveryScope[],
  rootTurnEndSeq: number,
): RecoveryCapsule {
  const scopes = [...scopesInput].sort((left, right) => {
    if (left.sessionId === packet.sessionId) return -1
    if (right.sessionId === packet.sessionId) return 1
    return left.sessionId.localeCompare(right.sessionId)
  })
  if (scopes.length === 0 || scopes[0]?.sessionId !== packet.sessionId || scopes.length > 65) {
    throw new Error('recovery capsule requires one complete root-first run tree of at most 65 sessions')
  }
  const activity = mergedActivity(scopes)
  const ledgers = scopes.map(uncertainEffects)
  const effectTotal = ledgers.reduce((total, ledger) => total + ledger.total, 0)
  const effectEntries = ledgers.flatMap(ledger => ledger.entries).slice(0, UNCERTAIN_EFFECTS_LIMIT)
  const objective = packet.objective.slice(0, 1_024)
  const baselineStatus = packet.baseline?.statusSummary.slice(0, 1_024)
  const observedTokens = Object.values(activity.tokenUsage).reduce((total, value) => total + value, 0)
  const root = scopes[0]
  const body: Omit<RecoveryCapsule, 'byteLength'> = {
    schemaVersion: 1,
    source: 'DURABLE_EVENT_FOLD',
    modelCallsUsed: 0,
    maxBytes: RECOVERY_CAPSULE_MAX_BYTES,
    parentRunId: packet.runId,
    objective,
    objectiveTruncated: objective.length < packet.objective.length,
    interruption: { kind: 'HOST_RESTART_INTERRUPTED', boundarySeq: rootTurnEndSeq, asOfSeq: rootTurnEndSeq },
    runTree: {
      coverage: 'complete',
      totalSessions: scopes.length,
      sessions: scopes.map(scope => ({
        sessionId: scope.sessionId,
        activationSeq: scope.activationSeq,
        terminalSeq: scope.terminalSeq,
      })),
    },
    ...root === undefined ? {} : (() => {
      const progress = acceptedProgress(root, packet)
      return progress === undefined ? {} : { lastAcceptedProgress: progress }
    })(),
    workspace: {
      ...packet.baseline === undefined || baselineStatus === undefined ? {} : { baseline: {
        ...packet.baseline.head === undefined ? {} : { head: packet.baseline.head.slice(0, 128) },
        statusSummary: baselineStatus,
        truncated: baselineStatus.length < packet.baseline.statusSummary.length
          || (packet.baseline.head?.length ?? 0) > 128,
      } },
      activity,
    },
    ...packet.budget === undefined ? {} : { budget: {
      limitTokens: packet.budget.maxTokens,
      observedTokens,
      remainingTokens: Math.max(0, packet.budget.maxTokens - observedTokens),
      exhausted: observedTokens >= packet.budget.maxTokens,
    } },
    uncertainEffects: {
      source: 'DURABLE_EVENT_FOLD',
      total: effectTotal,
      entries: effectEntries,
      truncated: ledgers.some(ledger => ledger.truncated) || effectTotal > effectEntries.length,
    },
    continuation: {
      action: effectTotal === 0 ? 'CONTINUE_FROM_DURABLE_EVIDENCE' : 'RECONCILE_UNCERTAIN_EFFECTS_THEN_CONTINUE',
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
  if (byteLength > RECOVERY_CAPSULE_MAX_BYTES) {
    throw new Error(`recovery capsule exceeds ${String(RECOVERY_CAPSULE_MAX_BYTES)} bytes`)
  }
  return { ...body, byteLength }
}
