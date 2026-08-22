import {
  TASK_PACKET_END, TASK_PACKET_START,
  type DshEvent, type Observation, type ProgressHeartbeat, type TaskPacket, type TaskRuntimeState,
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
    const start = text.indexOf(TASK_PACKET_START)
    const end = text.indexOf(TASK_PACKET_END, start + TASK_PACKET_START.length)
    if (start < 0 || end < 0) continue
    const raw = text.slice(start + TASK_PACKET_START.length, end).trim()
    try {
      const value = JSON.parse(raw) as TaskPacket
      if (value.schemaVersion === 1
        && typeof value.taskId === 'string'
        && typeof value.completionToken === 'string'
        && typeof value.objective === 'string'
        && (value.writerMode === 'writer' || value.writerMode === 'read_only')) return { packet: value, seq: event.seq }
    } catch {
      return undefined
    }
  }
  return undefined
}

export function parseTaskPacket(events: readonly DshEvent[]): TaskPacket | undefined {
  return taskPacketBoundary(events)?.packet
}

/**
 * Sequence of the latest durable task-packet boundary, or undefined when the
 * session history has no valid packet. Used to bound the in-memory event cache:
 * events older than the boundary are never needed by the fold.
 */
export function taskBoundarySeq(events: readonly DshEvent[]): number | undefined {
  return taskPacketBoundary(events)?.seq
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
  return {
    fromAsOfSeq,
    toAsOfSeq: asOfSeq,
    observedEvents: delta.length,
    steps: {
      completed: scoped.filter(event => event.type === 'step/end').length,
      delta: delta.filter(event => event.type === 'step/end').length,
    },
    tools: { totalCalls: toolCalls.length, deltaCalls: deltaToolCalls.length, deltaByName },
    tokenDelta: subtractTokens(tokensAt(state.events, asOfSeq), tokensAt(state.events, fromAsOfSeq)),
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
  return {
    schemaVersion: 1,
    hostInstanceId: state.hostInstanceId,
    taskId: packet?.taskId ?? 'unknown',
    objective: packet?.objective ?? '',
    workerState: state.workerState,
    stage: 'unknown',
    summary: '',
    files: [],
    verification: [],
    artifacts: [],
    ...state.telemetry === undefined ? {} : { telemetry: state.telemetry },
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
    if (args.taskId !== packet.taskId || args.completionToken !== packet.completionToken) continue
    const result = toolResultFor(state.events, data.callId, turnEnd.seq)
    if (result === undefined) continue
    const output = parsedResult(result) as { accepted?: unknown; artifacts?: unknown } | undefined
    if (output?.accepted !== true || !Array.isArray(output.artifacts)) continue
    const common = {
      ...base(state, packet),
      boundarySeq: turnEnd.seq,
      stage: typeof args.stage === 'string' ? args.stage : 'unknown',
      summary: typeof args.summary === 'string' ? args.summary.slice(0, 2_048) : '',
      files: Array.isArray(args.files) ? args.files.filter((item): item is string => typeof item === 'string') : [],
      verification: Array.isArray(args.verification) ? args.verification as Observation['verification'] : [],
      artifacts: output.artifacts as Observation['artifacts'],
      ...typeof args.blocker === 'string' ? { blocker: args.blocker } : {},
      ...typeof args.failureSignature === 'string' ? { failureSignature: args.failureSignature } : {},
      ...Array.isArray(args.attemptedHypotheses)
        ? { attemptedHypotheses: args.attemptedHypotheses.filter((item): item is string => typeof item === 'string') }
        : {},
    }
    switch (args.status) {
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
      ...typeof output.failureSignature === 'string' ? { failureSignature: output.failureSignature } : {},
    }
  }
  return undefined
}

export function deriveObservation(state: TaskRuntimeState): Observation {
  const boundary = taskPacketBoundary(state.events)
  const packet = boundary?.packet
  const common = base(state, packet)
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
    const reason = (turnEnd.data as { reason?: { kind?: unknown } }).reason?.kind
    const missing = reason === 'completed'
    return {
      ...common,
      status: 'FAILED',
      boundarySeq: turnEnd.seq,
      stage: 'turn-ended',
      summary: missing ? 'Turn ended without a valid supervisor handoff.' : `Worker turn ended: ${String(reason ?? 'unknown')}.`,
      failure: {
        kind: missing ? 'MISSING_HANDOFF' : 'WORKER_FAILED',
        message: missing ? 'turn/end is not success without a valid matching supervisor_handoff result' : `turn ended with ${String(reason ?? 'unknown')}`,
        retryable: missing,
      },
    }
  }
  return { ...common, status: 'WAITING', stage: state.workerState === 'RUNNING' ? 'running' : 'idle', summary: 'No completed supervisor boundary observed.' }
}

export function timeoutObservation(current: Observation, timeoutMs: number): Observation {
  if (current.status !== 'WAITING') return current
  return { ...current, wait: { reason: 'TIMEOUT', timeoutMs } }
}
