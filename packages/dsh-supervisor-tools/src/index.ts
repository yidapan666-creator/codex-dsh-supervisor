/** DSH tools that make an external supervisor handoff explicit and durable. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { admitArtifacts } from './artifacts.js'

export { admitArtifact, admitArtifacts, type ArtifactManifestEntry } from './artifacts.js'

export const name = 'dsh-gate-supervisor-tools'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** Exact worker-reported failure signatures accepted before forced escalation. */
  maxReportedFailuresPerSignature?: number
}

export const Config: z<Config> = z.object({
  maxReportedFailuresPerSignature: z.natural().min(1).max(20).default(2),
})

const HANDOFF_STATUSES = [
  'completed', 'blocked', 'major_checkpoint', 'escalation_required', 'failed',
] as const
const TASK_PACKET_START = '<dsh-supervised-task>'
const TASK_PACKET_END = '</dsh-supervised-task>'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Maximum length of `supervisor_handoff.summary`. Longer reports must become artifacts. */
export const HANDOFF_SUMMARY_LIMIT = 2_048
/** Ordinary semantic progress records are accepted at most once per minute. */
export const SUPERVISOR_PROGRESS_MIN_INTERVAL_MS = 60_000

/**
 * Validate the handoff summary length. Returns undefined when the summary is at
 * or below {@link HANDOFF_SUMMARY_LIMIT}, otherwise an actionable error message
 * that tells the worker to write the detailed report under `.dsh-handoff/<taskId>/`
 * inside the session cwd and reference it from a concise summary. The tool never
 * writes handoff data itself; it only reports how to recover.
 */
export function handoffSummaryError(summary: string, taskId?: string): string | undefined {
  if (summary.length <= HANDOFF_SUMMARY_LIMIT) return undefined
  const reportDir = taskId === undefined || taskId.trim() === '' ? '.dsh-handoff/<taskId>/' : `.dsh-handoff/${taskId}/`
  return `supervisor_handoff.summary exceeds ${HANDOFF_SUMMARY_LIMIT} characters (got ${summary.length}). `
    + `Keep the summary at or below ${HANDOFF_SUMMARY_LIMIT} characters. When more detail is needed, write a `
    + `Markdown report under ${reportDir} inside the session cwd (the directory is gitignored), include its `
    + `relative path in the artifacts array, and reference it from the concise summary.`
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

type HandoffIdentityArgs = {
  taskId?: string | undefined
  sessionId?: string | undefined
  runId?: string | undefined
  completionToken: string
}

type ProgressIdentityArgs = {
  taskId?: string | undefined
  sessionId?: string | undefined
  runId?: string | undefined
}

export type SupervisorProgressArgs = ProgressIdentityArgs & {
  phase: 'investigating' | 'implementing' | 'verifying' | 'recovering'
  milestone: string
  nextAction: string
  currentHypothesis?: string | undefined
  risk?: string | undefined
  needsSupervisor: boolean
  decision?: {
    category: 'architecture' | 'scope' | 'acceptance' | 'security' | 'destructive_action'
      | 'credentials' | 'external_side_effect' | 'recovery' | 'information' | 'unspecified'
    impact: 'low' | 'medium' | 'high'
    blocking: boolean
    requiresHuman?: boolean | undefined
    request: string
    options?: string[] | undefined
    recommendation?: string | undefined
  } | undefined
}

type TaskIdentity = {
  schemaVersion: 1 | 2
  sessionId: string
  runId?: string | undefined
  completionToken: string
}

function latestTaskIdentity(events: readonly { type: string; data: unknown }[]): TaskIdentity | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const data = event.data as { content?: unknown; message?: { content?: unknown } }
    const text = contentText(data.content ?? data.message?.content)
    const end = text.lastIndexOf(TASK_PACKET_END)
    if (end < 0) continue
    let before = end
    while (before >= 0) {
      const start = text.lastIndexOf(TASK_PACKET_START, before)
      if (start < 0) break
      try {
        const value = JSON.parse(text.slice(start + TASK_PACKET_START.length, end).trim()) as Record<string, unknown>
        if (value.schemaVersion === 2
          && typeof value.sessionId === 'string' && value.sessionId.length > 0
          && typeof value.runId === 'string' && UUID_PATTERN.test(value.runId)
          && typeof value.completionToken === 'string' && UUID_PATTERN.test(value.completionToken)
          && typeof value.objective === 'string' && value.objective.length > 0
          && (value.writerMode === 'writer' || value.writerMode === 'read_only')) {
          return {
            schemaVersion: 2,
            sessionId: value.sessionId,
            runId: value.runId,
            completionToken: value.completionToken,
          }
        }
        if (value.schemaVersion === 1
          && typeof value.taskId === 'string' && value.taskId.length > 0
          && typeof value.completionToken === 'string' && value.completionToken.length > 0
          && typeof value.objective === 'string' && value.objective.length > 0
          && (value.writerMode === 'writer' || value.writerMode === 'read_only')) {
          return { schemaVersion: 1, sessionId: value.taskId, completionToken: value.completionToken }
        }
      } catch { /* Try an earlier opening marker in the same message. */ }
      before = start - 1
    }
  }
  return undefined
}

/** Validate a handoff against the latest durable task packet before concluding the turn. */
export function handoffIdentityError(
  events: readonly { type: string; data: unknown }[],
  args: HandoffIdentityArgs,
): string | undefined {
  const identity = latestTaskIdentity(events)
  if (identity === undefined) return 'supervisor_handoff found no valid latest dsh-gate task packet'
  const addressError = taskAddressError(identity, args, 'supervisor_handoff')
  if (addressError !== undefined) return addressError
  if (args.completionToken !== identity.completionToken) {
    return 'supervisor_handoff completionToken does not match the latest task packet'
  }
  return undefined
}

function taskAddressError(
  identity: TaskIdentity,
  args: ProgressIdentityArgs,
  toolName: string,
): string | undefined {
  if (identity.schemaVersion === 2) {
    if (args.sessionId !== identity.sessionId) return `${toolName} sessionId does not match the latest task packet`
    if (args.runId !== identity.runId) return `${toolName} runId does not match the latest task packet`
  } else if (args.taskId !== identity.sessionId) {
    return `${toolName} taskId does not match the latest task packet`
  }
  return undefined
}

/** Validate a semantic progress record against the latest durable task packet. */
export function progressIdentityError(
  events: readonly { type: string; data: unknown }[],
  args: ProgressIdentityArgs,
): string | undefined {
  const identity = latestTaskIdentity(events)
  if (identity === undefined) return 'supervisor_progress found no valid latest dsh-gate task packet'
  return taskAddressError(identity, args, 'supervisor_progress')
}

function latestTaskBoundary(events: readonly { type: string; data: unknown }[]): number {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const data = event.data as { content?: unknown; message?: { content?: unknown } }
    if (contentText(data.content ?? data.message?.content).includes(TASK_PACKET_START)) return index
  }
  return 0
}

function sameProgress(left: SupervisorProgressArgs, right: SupervisorProgressArgs): boolean {
  return left.phase === right.phase
    && left.milestone === right.milestone
    && left.nextAction === right.nextAction
    && left.currentHypothesis === right.currentHypothesis
    && left.risk === right.risk
    && left.needsSupervisor === right.needsSupervisor
    && JSON.stringify(left.decision) === JSON.stringify(right.decision)
}

/**
 * Decide whether the current progress call should become an accepted durable
 * record. DSH records tool/call before execute, so the last matching call is
 * the current one and earlier calls are the rate-limit/deduplication history.
 */
export function supervisorProgressDecision(
  events: readonly { type: string; time?: number; data: unknown }[],
  args: SupervisorProgressArgs,
  now = Date.now(),
): { accepted: true } | { accepted: false; reason: 'duplicate' | 'rate_limited' } {
  const calls = events.slice(latestTaskBoundary(events)).flatMap((event) => {
    if (event.type !== 'tool/call') return []
    const data = event.data as { name?: unknown; arguments?: unknown }
    if (data.name !== 'supervisor_progress' || typeof data.arguments !== 'string') return []
    try {
      return [{ args: JSON.parse(data.arguments) as SupervisorProgressArgs, time: event.time }]
    } catch { return [] }
  })
  const previous = calls.at(-2)
  if (previous === undefined) return { accepted: true }
  if (sameProgress(previous.args, args)) return { accepted: false, reason: 'duplicate' }
  if (!args.needsSupervisor && args.decision === undefined
    && typeof previous.time === 'number' && now - previous.time < SUPERVISOR_PROGRESS_MIN_INTERVAL_MS) {
    return { accepted: false, reason: 'rate_limited' }
  }
  return { accepted: true }
}

export function reportedFailureDecision(
  events: readonly { type: string; data: unknown }[],
  signature: string,
  budget: number,
): { count: number; exhausted: boolean } {
  const count = events.slice(latestTaskBoundary(events)).filter((event) => {
    if (event.type !== 'tool/call') return false
    const data = event.data as { name?: unknown; arguments?: unknown }
    if (data.name !== 'supervisor_report_failure' || typeof data.arguments !== 'string') return false
    try {
      const parsed = JSON.parse(data.arguments) as { failureSignature?: unknown }
      return parsed.failureSignature === signature
    } catch {
      return false
    }
  }).length
  return { count, exhausted: count >= budget }
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = Config(config) as Required<Config>

  ctx.systemPrompt.section({
    name: 'tool:supervisor-handoff',
    order: 195,
    text: 'You are supervised by an external runtime. Before ending a task, call '
      + '`supervisor_handoff` exactly once. For a schemaVersion 2 packet, pass its sessionId, runId, and completionToken; '
      + 'for a legacy schemaVersion 1 packet, pass taskId and completionToken. '
      + 'Keep `supervisor_handoff.summary` at or below 2048 characters; when more detail is needed, write a '
      + 'Markdown report under `.dsh-handoff/<runId>/` inside the session cwd, include its relative path in '
      + '`artifacts`, and reference it from the concise summary. '
      + 'Use `supervisor_progress` only for bounded milestone changes; it never ends the turn. When a decision is needed, '
      + 'include the structured decision category, impact, blocking state, request, options, and recommendation. '
      + '`needsSupervisor` is a migration hint; the runtime policy decides whether the request interrupts immediately or '
      + 'is folded into the normal progress cadence. Never claim pre-authorization yourself. '
      + 'A normal turn ending without that valid handoff is not success. Report repeated failures through '
      + '`supervisor_report_failure`; its budget is enforced from your reported failureSignature, while deciding '
      + 'whether two failures are semantically the same remains your responsibility.',
  })

  ctx.tools.register(defineTool({
    name: 'supervisor_progress',
    description: 'Publish bounded semantic progress for the next aggregated heartbeat without exposing reasoning, diffs, '
      + 'tool arguments, or tool output. This tool never concludes the turn. Duplicate and overly frequent ordinary records are ignored.',
    parameters: {
      taskId: { type: 'string', description: 'Legacy schemaVersion 1 session/task id.' },
      sessionId: { type: 'string', description: 'SchemaVersion 2 durable DSH session id.' },
      runId: { type: 'string', description: 'SchemaVersion 2 supervised run id.' },
      phase: { type: 'string', required: true, enum: ['investigating', 'implementing', 'verifying', 'recovering'] },
      milestone: { type: 'string', required: true, maxLength: 512 },
      nextAction: { type: 'string', required: true, maxLength: 512 },
      currentHypothesis: { type: 'string', maxLength: 1024 },
      risk: { type: 'string', maxLength: 512 },
      needsSupervisor: { type: 'boolean', required: true },
      decision: {
        type: 'object', additionalProperties: false,
        properties: {
          category: {
            type: 'string', required: true,
            enum: ['architecture', 'scope', 'acceptance', 'security', 'destructive_action', 'credentials', 'external_side_effect', 'recovery', 'information', 'unspecified'],
          },
          impact: { type: 'string', required: true, enum: ['low', 'medium', 'high'] },
          blocking: { type: 'boolean', required: true },
          requiresHuman: { type: 'boolean' },
          request: { type: 'string', required: true, maxLength: 512 },
          options: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 256 } },
          recommendation: { type: 'string', maxLength: 512 },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          reason: { type: 'string', enum: ['duplicate', 'rate_limited'] },
          progress: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      if (exec.agent === undefined) throw new Error('supervisor_progress requires an agent-owned session')
      const events = exec.agent.session.events
      const identityError = progressIdentityError(events, args)
      if (identityError !== undefined) throw new Error(identityError)
      const decision = supervisorProgressDecision(events, args)
      if (!decision.accepted) return Promise.resolve({ accepted: false as const, reason: decision.reason })
      const progress = {
        ...args.taskId === undefined ? {} : { taskId: args.taskId },
        ...args.sessionId === undefined ? {} : { sessionId: args.sessionId },
        ...args.runId === undefined ? {} : { runId: args.runId },
        phase: args.phase,
        milestone: args.milestone,
        nextAction: args.nextAction,
        ...args.currentHypothesis === undefined ? {} : { currentHypothesis: args.currentHypothesis },
        ...args.risk === undefined ? {} : { risk: args.risk },
        needsSupervisor: args.needsSupervisor,
        ...args.decision === undefined ? {} : { decision: args.decision },
      }
      return Promise.resolve({ accepted: true as const, progress })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'supervisor_report_failure',
    description: 'Report one failed recovery attempt using your stable semantic failure signature. The runtime '
      + 'counts that reported signature exactly and forces the turn to end at the configured budget.',
    parameters: {
      failureSignature: { type: 'string', required: true, description: 'Stable semantic signature chosen by the worker.' },
      summary: { type: 'string', required: true, description: 'What failed and the evidence observed.' },
      hypothesis: { type: 'string', required: true, description: 'The recovery hypothesis attempted.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          exhausted: { type: 'boolean', required: true },
          failureSignature: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          budget: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      const events = exec.agent?.session.events ?? []
      const { count, exhausted } = reportedFailureDecision(
        events,
        args.failureSignature,
        resolved.maxReportedFailuresPerSignature,
      )
      if (exhausted) exec.concludeTurn()
      return Promise.resolve({
        accepted: true,
        exhausted,
        failureSignature: args.failureSignature,
        count,
        budget: resolved.maxReportedFailuresPerSignature,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'supervisor_handoff',
    description: 'Create the authoritative external-supervisor handoff and conclude this turn. Completion is valid '
      + 'only when the packet session/run identity and completionToken match and this successful tool result is followed by '
      + 'the corresponding turn/end event.',
    parameters: {
      taskId: { type: 'string', description: 'Legacy schemaVersion 1 session/task id.' },
      sessionId: { type: 'string', description: 'SchemaVersion 2 durable DSH session id.' },
      runId: { type: 'string', description: 'SchemaVersion 2 supervised run id.' },
      completionToken: { type: 'string', required: true },
      status: { type: 'string', required: true, enum: [...HANDOFF_STATUSES] },
      stage: { type: 'string', required: true },
      summary: { type: 'string', required: true },
      files: { type: 'array', required: true, items: { type: 'string' } },
      verification: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            command: { type: 'string', required: true },
            outcome: { type: 'string', required: true, enum: ['passed', 'failed', 'not_run'] },
            summary: { type: 'string', required: true },
          },
        },
      },
      blocker: { type: 'string' },
      failureSignature: { type: 'string' },
      attemptedHypotheses: { type: 'array', items: { type: 'string' } },
      artifacts: { type: 'array', required: true, items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', const: true, required: true },
          handoff: { type: 'json', required: true },
          artifacts: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                sha256: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('supervisor_handoff requires an agent-owned session')
      const identityError = handoffIdentityError(exec.agent.session.events, args)
      if (identityError !== undefined) throw new Error(identityError)
      const summaryError = handoffSummaryError(args.summary, args.runId ?? args.taskId)
      if (summaryError !== undefined) throw new Error(summaryError)
      const artifacts = await admitArtifacts(exec.agent.session.header.cwd, args.artifacts)
      const handoff = {
        ...args.taskId === undefined ? {} : { taskId: args.taskId },
        ...args.sessionId === undefined ? {} : { sessionId: args.sessionId },
        ...args.runId === undefined ? {} : { runId: args.runId },
        completionToken: args.completionToken,
        status: args.status,
        stage: args.stage,
        summary: args.summary,
        files: args.files,
        verification: args.verification,
        ...args.blocker === undefined ? {} : { blocker: args.blocker },
        ...args.failureSignature === undefined ? {} : { failureSignature: args.failureSignature },
        ...args.attemptedHypotheses === undefined ? {} : { attemptedHypotheses: args.attemptedHypotheses },
      }
      exec.concludeTurn()
      return { accepted: true as const, handoff, artifacts }
    },
  }))
}
