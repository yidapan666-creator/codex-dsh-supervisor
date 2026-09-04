/** DSH tools that make an external supervisor handoff explicit and durable. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { admitArtifacts } from './artifacts.js'
import {
  FileBudgetReservationLedger,
  type BudgetReservationLedger,
  type DurableBudgetReservation,
} from './reservation-ledger.js'
import { FileGitBaselineStore, type GitBaselineVerification } from './git-baseline.js'
import { authorizeSupervisorRequest, requiredHostToken } from './host-auth.js'
import { DSH_GATE_COMPILED_BUILD_ID } from './build-identity.js'
import {
  HostRecoveryCoordinator,
  registerRecoveryCapsuleRoute,
  registerTaskAdmissionRoute,
  TaskAdmissionCoordinator,
  type TaskAdmissionRuntime,
} from './admission.js'

export { admitArtifact, admitArtifacts, type ArtifactManifestEntry } from './artifacts.js'
export {
  FileBudgetReservationLedger,
  MemoryBudgetReservationLedger,
  defaultBudgetReservationDirectory,
  type BudgetReservationLedger,
  type DurableBudgetReservation,
} from './reservation-ledger.js'
export {
  FileGitBaselineStore,
  defaultGitBaselineDirectory,
  type GitBaselineRecord,
  type GitBaselineStore,
  type GitBaselineVerification,
} from './git-baseline.js'
export {
  HostRecoveryCoordinator,
  RECOVERY_CAPSULE_PATH,
  registerRecoveryCapsuleRoute,
  registerTaskAdmissionRoute,
  TASK_ADMISSION_PATH,
  TaskAdmissionCoordinator,
  TaskAdmissionError,
  type TaskAdmissionErrorCode,
  type TaskAdmissionReceipt,
  type TaskAdmissionRequest,
  type TaskAdmissionRuntime,
} from './admission.js'
export {
  RECOVERY_CAPSULE_MAX_BYTES,
  UNCERTAIN_EFFECTS_LIMIT,
  affiliatedChildActivation,
  buildRecoveryCapsule,
  type RecoveryCapsule,
  type RecoveryEvent,
  type RecoveryScope,
  type RecoveryTaskPacket,
} from './recovery.js'

export const name = 'dsh-gate-supervisor-tools'
export const DSH_GATE_DESCRIPTOR_PATH = '/api/dsh-gate.describe'
export const DSH_GATE_PROTOCOL_VERSION = 1
export const DSH_GATE_PLUGIN_VERSION = '0.1.0'
export const DSH_GATE_CAPABILITIES = [
  'idempotent-admission-v1',
  'durable-before-execute-v1',
  'recovery-capsule-v1',
  'run-tree-token-budget-v1',
  'crash-durable-token-reservations-v1',
  'host-git-baseline-v1',
  'direct-child-authority-v1',
  'strict-handoff-v1',
  'bearer-auth-v1',
] as const
export const inject = [
  'tools', 'systemPrompt', 'tokenMeter', 'agents', 'sessions', 'sessionPersistence', 'apiProxy', 'webServer',
  'sandboxPolicy', 'approval',
]

export interface Config {
  /** Exact worker-reported failure signatures accepted before forced escalation. */
  maxReportedFailuresPerSignature?: number
  /** Largest output reservation granted to one model request under a run budget. */
  maxReservedOutputTokensPerRequest?: number
  /** Model-facing tool names that establish a direct child and consume run authority. */
  directChildToolNames?: string[]
}

export const Config: z<Config> = z.object({
  maxReportedFailuresPerSignature: z.natural().min(1).max(20).default(2),
  maxReservedOutputTokensPerRequest: z.natural().min(1).max(131_072).default(8_192),
  directChildToolNames: z.array(z.string()).default(['subagent', 'subagent_fork']),
})

const HANDOFF_STATUSES = [
  'completed', 'blocked', 'major_checkpoint', 'escalation_required', 'failed',
] as const
const TASK_PACKET_START = '<dsh-supervised-task>'
const TASK_PACKET_END = '</dsh-supervised-task>'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Maximum length of `supervisor_handoff.summary`. Longer reports must become artifacts. */
export const HANDOFF_SUMMARY_LIMIT = 2_048
export const HANDOFF_STAGE_LIMIT = 128
export const HANDOFF_FILES_LIMIT = 64
export const HANDOFF_PATH_LIMIT = 256
export const HANDOFF_VERIFICATION_LIMIT = 32
export const HANDOFF_VERIFICATION_COMMAND_LIMIT = 256
export const HANDOFF_VERIFICATION_SUMMARY_LIMIT = 512
export const HANDOFF_BLOCKER_LIMIT = 1_024
export const HANDOFF_FAILURE_SIGNATURE_LIMIT = 256
export const HANDOFF_HYPOTHESES_LIMIT = 16
export const HANDOFF_HYPOTHESIS_LIMIT = 512
export const HANDOFF_ARTIFACTS_LIMIT = 16
export const HANDOFF_ARTIFACT_PATH_LIMIT = 512
export const REPORTED_FAILURE_SUMMARY_LIMIT = 1_024
export const REPORTED_FAILURE_HYPOTHESIS_LIMIT = 512
/** Ordinary semantic progress records are accepted at most once per minute. */
export const SUPERVISOR_PROGRESS_MIN_INTERVAL_MS = 60_000
export const WORKSPACE_CHANGES_FILES_LIMIT = 16
export const WORKSPACE_CHANGE_PATH_LIMIT = 200
export const TOKEN_BUDGET_STATE_PATH = '/api/dsh-gate.budget-state'

export interface WorkspaceChangesEvidence {
  source: 'HOST_GIT_BASELINE'
  total: number
  files: string[]
  truncated: boolean
}

/** Bound Host-authoritative task-era Git changes before they enter model or supervisor context. */
export function boundedWorkspaceChanges(verification: GitBaselineVerification): WorkspaceChangesEvidence {
  const files = verification.changedPaths
    .filter(path => path.length <= WORKSPACE_CHANGE_PATH_LIMIT)
    .slice(0, WORKSPACE_CHANGES_FILES_LIMIT)
  return {
    source: 'HOST_GIT_BASELINE',
    total: verification.changedPaths.length,
    files,
    truncated: files.length < verification.changedPaths.length,
  }
}

const workspaceChangesOutput = () => ({
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    source: { type: 'string' as const, required: true as const, enum: ['HOST_GIT_BASELINE'] },
    total: { type: 'integer' as const, required: true as const },
    files: { type: 'array' as const, required: true as const, items: { type: 'string' as const } },
    truncated: { type: 'boolean' as const, required: true as const },
  },
})

/** Plugin-owned readiness endpoint; proves the generic Host loaded the expected supervisor runtime. */
export function registerSupervisorDescriptorRoute(
  webServer: SupervisorRuntimeContext['webServer'],
): () => void {
  return webServer.register({
    kind: 'exact',
    path: DSH_GATE_DESCRIPTOR_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!authorizeSupervisorRequest(req, res)) return
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
        res.end()
        return
      }
      const body = JSON.stringify({
        schemaVersion: 1,
        gateProtocolVersion: DSH_GATE_PROTOCOL_VERSION,
        pluginName: '@dsh-gate/supervisor-tools',
        pluginVersion: DSH_GATE_PLUGIN_VERSION,
        buildId: DSH_GATE_COMPILED_BUILD_ID,
        workerProtocolVersion: 2,
        capabilities: DSH_GATE_CAPABILITIES,
      })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    },
  })
}

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

export type HandoffPayloadArgs = HandoffIdentityArgs & {
  status: typeof HANDOFF_STATUSES[number]
  stage: string
  summary: string
  files: string[]
  verification: Array<{ command: string; outcome: 'passed' | 'failed' | 'not_run'; summary: string }>
  blocker?: string | undefined
  failureSignature?: string | undefined
  attemptedHypotheses?: string[] | undefined
  artifacts: string[]
}

/** Defense-in-depth for programmatic callers that bypass the generated tool schema. */
export function handoffPayloadError(args: HandoffPayloadArgs): string | undefined {
  if (args.status === 'completed') {
    const nonPassing = args.verification.find(entry => entry.outcome !== 'passed')
    if (nonPassing !== undefined) {
      return `supervisor_handoff status completed cannot include verification outcome ${nonPassing.outcome}; report blocked or failed, or complete the verification first.`
    }
  }
  const checks: Array<[boolean, string]> = [
    [args.stage.length > HANDOFF_STAGE_LIMIT, `stage exceeds ${HANDOFF_STAGE_LIMIT} characters`],
    [args.files.length > HANDOFF_FILES_LIMIT, `files exceeds ${HANDOFF_FILES_LIMIT} entries`],
    [args.files.some(value => value.length > HANDOFF_PATH_LIMIT), `a files path exceeds ${HANDOFF_PATH_LIMIT} characters`],
    [args.verification.length > HANDOFF_VERIFICATION_LIMIT, `verification exceeds ${HANDOFF_VERIFICATION_LIMIT} entries`],
    [args.verification.some(value => value.command.length > HANDOFF_VERIFICATION_COMMAND_LIMIT),
      `a verification command exceeds ${HANDOFF_VERIFICATION_COMMAND_LIMIT} characters`],
    [args.verification.some(value => value.summary.length > HANDOFF_VERIFICATION_SUMMARY_LIMIT),
      `a verification summary exceeds ${HANDOFF_VERIFICATION_SUMMARY_LIMIT} characters`],
    [(args.blocker?.length ?? 0) > HANDOFF_BLOCKER_LIMIT, `blocker exceeds ${HANDOFF_BLOCKER_LIMIT} characters`],
    [(args.failureSignature?.length ?? 0) > HANDOFF_FAILURE_SIGNATURE_LIMIT,
      `failureSignature exceeds ${HANDOFF_FAILURE_SIGNATURE_LIMIT} characters`],
    [(args.attemptedHypotheses?.length ?? 0) > HANDOFF_HYPOTHESES_LIMIT,
      `attemptedHypotheses exceeds ${HANDOFF_HYPOTHESES_LIMIT} entries`],
    [args.attemptedHypotheses?.some(value => value.length > HANDOFF_HYPOTHESIS_LIMIT) === true,
      `an attempted hypothesis exceeds ${HANDOFF_HYPOTHESIS_LIMIT} characters`],
    [args.artifacts.length > HANDOFF_ARTIFACTS_LIMIT, `artifacts exceeds ${HANDOFF_ARTIFACTS_LIMIT} entries`],
    [args.artifacts.some(value => value.length > HANDOFF_ARTIFACT_PATH_LIMIT),
      `an artifact path exceeds ${HANDOFF_ARTIFACT_PATH_LIMIT} characters`],
  ]
  const failure = checks.find(([exceeded]) => exceeded)?.[1]
  if (failure === undefined) return undefined
  const runId = args.runId ?? args.taskId ?? '<runId>'
  return `supervisor_handoff ${failure}. Keep the handoff compact; write complete detail under `
    + `.dsh-handoff/${runId}/ inside the session cwd and reference that report in artifacts.`
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

/**
 * DSH rc.8's public tool-schema DSL validates structure but does not support
 * JSON Schema length/count keywords. Enforce the model-facing size bounds at
 * the Host execution boundary so every caller, including programmatic ones,
 * receives the same protection.
 */
export function progressPayloadError(args: SupervisorProgressArgs): string | undefined {
  const checks: Array<[boolean, string]> = [
    [args.milestone.length > 512, 'milestone exceeds 512 characters'],
    [args.nextAction.length > 512, 'nextAction exceeds 512 characters'],
    [(args.currentHypothesis?.length ?? 0) > 1_024, 'currentHypothesis exceeds 1024 characters'],
    [(args.risk?.length ?? 0) > 512, 'risk exceeds 512 characters'],
    [(args.decision?.request.length ?? 0) > 512, 'decision.request exceeds 512 characters'],
    [(args.decision?.options?.length ?? 0) > 5, 'decision.options exceeds 5 entries'],
    [args.decision?.options?.some(value => value.length > 256) === true,
      'a decision option exceeds 256 characters'],
    [(args.decision?.recommendation?.length ?? 0) > 512,
      'decision.recommendation exceeds 512 characters'],
  ]
  const failure = checks.find(([exceeded]) => exceeded)?.[1]
  return failure === undefined ? undefined : `supervisor_progress ${failure}`
}

type TaskIdentity = {
  schemaVersion: 1 | 2
  sessionId: string
  runId?: string | undefined
  completionToken: string
  tokenBudget?: number | undefined
  maxDirectChildren?: number | undefined
  writerMode: 'writer' | 'read_only'
}

type TaskIdentityBoundary = { identity: TaskIdentity; boundarySeq: number; boundaryTime?: number }

interface RuntimeSessionHeader {
  id: string
  createdAt?: number
  parentSession?: string
  seedLength?: number
}

interface RuntimeEvent {
  type: string
  seq: number
  time?: number
  data: unknown
}

interface RuntimeSession {
  header: RuntimeSessionHeader
  events: readonly RuntimeEvent[]
}

interface RuntimeAgent {
  session: RuntimeSession
  cancel(cause: { kind: 'hook'; reason: string }): void
}

interface RuntimeToolExecution {
  readonly name: string
  readonly token: symbol
  readonly agent?: RuntimeAgent
}

interface RuntimeLlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: unknown
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

interface RuntimeRequestHeader {
  config: RuntimeLlmCallConfig
  system?: string
  tools?: PromptAssembly['tools']
}

interface SupervisorRuntimeContext {
  sessions: { list(): RuntimeSession[]; flush(session: RuntimeSession): Promise<boolean> }
  agents: { list(): RuntimeAgent[] }
  sessionPersistence: {
    listSnapshots(): Promise<Array<{ header: RuntimeSessionHeader; revision: string }>>
    inspect(id: string): Promise<{ meta: RuntimeSessionHeader; events: readonly RuntimeEvent[] }>
  }
  tokenMeter: {
    measure(session: RuntimeSession, requestHeader?: RuntimeRequestHeader): { totalTokens: number }
  }
  on(name: 'session/event', listener: (session: RuntimeSession, event: RuntimeEvent) => void): void
  on(
    name: 'agent/pre-step',
    listener: (payload: { agent: RuntimeAgent }, next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }>)
      => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }>,
  ): void
  on(
    name: 'tools/pre-execute',
    listener: (
      execution: RuntimeToolExecution,
      next: () => Promise<{ kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }>,
    ) => Promise<{ kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }>,
  ): void
  on(
    name: 'tools/result',
    listener: (execution: RuntimeToolExecution, result: { readonly isError: boolean }) => void,
  ): void
  on(
    name: 'agent/request',
    listener: (
      payload: { agent: RuntimeAgent; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<RuntimeLlmCallConfig>,
    ) => Promise<RuntimeLlmCallConfig>,
  ): void
  on(
    name: 'agent/request-error',
    listener: (
      payload: { agent: RuntimeAgent; turn: number; step: number },
      next: () => Promise<unknown>,
    ) => Promise<unknown>,
  ): void
  on(
    name: 'system-prompt/assemble',
    listener: (
      assembly: PromptAssembly,
      context: { agent?: RuntimeAgent },
      next: () => Promise<PromptAssembly>,
    ) => Promise<PromptAssembly>,
  ): void
  apiProxy: TaskAdmissionRuntime['apiProxy']
  sandboxPolicy: { defaultMode: 'read-only' | 'workspace-write' | 'danger-full-access' }
  approval: { config: { policy?: 'ask' | 'never' } }
  webServer: Parameters<typeof registerTaskAdmissionRoute>[0]
}

function latestTaskIdentityBoundary(
  events: readonly { type: string; seq?: number; time?: number; data: unknown }[],
): TaskIdentityBoundary | undefined {
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
        const maxTokens = (value.budget as { maxTokens?: unknown } | undefined)?.maxTokens
        const maxDirectChildren = (value.authority as { maxDirectChildren?: unknown } | undefined)?.maxDirectChildren
        if (value.schemaVersion === 2
          && typeof value.sessionId === 'string' && value.sessionId.length > 0
          && typeof value.runId === 'string' && UUID_PATTERN.test(value.runId)
          && typeof value.completionToken === 'string' && UUID_PATTERN.test(value.completionToken)
          && typeof value.objective === 'string' && value.objective.length > 0
          && (value.writerMode === 'writer' || value.writerMode === 'read_only')) {
          return {
            identity: {
              schemaVersion: 2,
              sessionId: value.sessionId,
              runId: value.runId,
              completionToken: value.completionToken,
              writerMode: value.writerMode,
              ...typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0
                ? { tokenBudget: maxTokens }
                : {},
              ...typeof maxDirectChildren === 'number'
                && Number.isSafeInteger(maxDirectChildren) && maxDirectChildren >= 0
                ? { maxDirectChildren }
                : {},
            },
            boundarySeq: event.seq ?? index,
            ...event.time === undefined ? {} : { boundaryTime: event.time },
          }
        }
        if (value.schemaVersion === 1
          && typeof value.taskId === 'string' && value.taskId.length > 0
          && typeof value.completionToken === 'string' && value.completionToken.length > 0
          && typeof value.objective === 'string' && value.objective.length > 0
          && (value.writerMode === 'writer' || value.writerMode === 'read_only')) {
          return {
            identity: {
              schemaVersion: 1, sessionId: value.taskId, completionToken: value.completionToken,
              writerMode: value.writerMode,
            },
            boundarySeq: event.seq ?? index,
            ...event.time === undefined ? {} : { boundaryTime: event.time },
          }
        }
      } catch { /* Try an earlier opening marker in the same message. */ }
      before = start - 1
    }
  }
  return undefined
}

function latestTaskIdentity(
  events: readonly { type: string; seq?: number; time?: number; data: unknown }[],
): TaskIdentity | undefined {
  return latestTaskIdentityBoundary(events)?.identity
}

interface TokenBuckets {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface TokenBudgetState extends TokenBuckets {
  runId: string
  limitTokens: number
  usedTokens: number
  remainingTokens: number
  exhausted: boolean
  sessions: number
}

export interface TokenBudgetStateRequest {
  schemaVersion: 1
  sessionId: string
  runId: string
}

export interface TokenBudgetStateReceipt extends TokenBudgetState {
  schemaVersion: 1
  sessionId: string
  coverage: 'run_tree'
  enforcement: 'DSH_HOST_RUNTIME'
  overshootBound: 'IN_FLIGHT_MODEL_RESPONSES'
}

function tokenNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function usageSample(event: { type: string; data: unknown }): { key: string; buckets: TokenBuckets } | undefined {
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

function ownTaskBoundaries(session: RuntimeSession): TaskIdentityBoundary[] {
  const ownStart = session.header.seedLength ?? 0
  return session.events.flatMap((event) => {
    if (event.seq < ownStart) return []
    const boundary = latestTaskIdentityBoundary([event])
    return boundary === undefined ? [] : [boundary]
  })
}

function eventWithinRunWindow(
  event: RuntimeEvent,
  startTime: number | undefined,
  endTime: number | undefined,
): boolean {
  if (event.time === undefined) return true
  return (startTime === undefined || event.time >= startTime)
    && (endTime === undefined || event.time < endTime)
}

/**
 * Find the durable boundary where one session joined a supervised run.
 *
 * Root sessions join at their own task packet. Descendants join when their own
 * suffix first accepts work during that root packet's time window. Fork seeds
 * are excluded by `seedLength`, so inherited parent usage is never counted.
 * A descendant with its own supervised task packet forms a nested run root and
 * is deliberately excluded from the outer run.
 */
function runAffiliationBoundary(
  session: RuntimeSession,
  root: RuntimeSession,
  runId: string,
): number | undefined {
  const rootBoundaries = ownTaskBoundaries(root)
  const rootIndex = rootBoundaries.findIndex(boundary =>
    boundary.identity.schemaVersion === 2
    && boundary.identity.sessionId === root.header.id
    && boundary.identity.runId === runId)
  if (rootIndex < 0) return undefined
  const rootBoundary = rootBoundaries[rootIndex]
  if (rootBoundary === undefined) return undefined
  if (session.header.id === root.header.id) return rootBoundary.boundarySeq

  const nextRootBoundary = rootBoundaries[rootIndex + 1]
  const nested = ownTaskBoundaries(session).find(boundary => eventWithinRunWindow(
    {
      type: 'user/message',
      seq: boundary.boundarySeq,
      data: null,
      ...boundary.boundaryTime === undefined ? {} : { time: boundary.boundaryTime },
    },
    rootBoundary.boundaryTime,
    nextRootBoundary?.boundaryTime,
  ))
  if (nested !== undefined) {
    return nested.identity.schemaVersion === 2
      && nested.identity.sessionId === session.header.id
      && nested.identity.runId === runId
      ? nested.boundarySeq
      : undefined
  }

  const ownStart = session.header.seedLength ?? 0
  return session.events.find(event => event.seq >= ownStart
    && event.type === 'user/message'
    && eventWithinRunWindow(event, rootBoundary.boundaryTime, nextRootBoundary?.boundaryTime))?.seq
}

function ownRunTokens(session: RuntimeSession, root: RuntimeSession, runId: string): TokenBuckets | undefined {
  const affiliationBoundary = runAffiliationBoundary(session, root, runId)
  if (affiliationBoundary === undefined) return undefined
  const fromSeq = Math.max(affiliationBoundary + 1, session.header.seedLength ?? 0)
  const samples = new Map<string, TokenBuckets>()
  for (const event of session.events) {
    if (event.seq < fromSeq) continue
    const sample = usageSample(event)
    if (sample !== undefined) samples.set(sample.key, sample.buckets)
  }
  const total: TokenBuckets = {
    uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  }
  for (const sample of samples.values()) {
    total.uncachedInputTokens += sample.uncachedInputTokens
    total.outputTokens += sample.outputTokens
    total.cacheReadTokens += sample.cacheReadTokens
    total.cacheWriteTokens += sample.cacheWriteTokens
  }
  return total
}

function isDescendantOf(
  header: RuntimeSessionHeader,
  rootId: string,
  headers: ReadonlyMap<string, RuntimeSessionHeader>,
): boolean {
  let current: RuntimeSessionHeader | undefined = header
  const seen = new Set<string>()
  while (current !== undefined) {
    const id = current.id
    if (id === rootId) return true
    if (seen.has(id) || current.parentSession === undefined) return false
    seen.add(id)
    current = headers.get(current.parentSession)
  }
  return false
}

function sumBudget(
  rootId: string,
  runId: string,
  limitTokens: number,
  sessions: readonly RuntimeSession[],
): TokenBudgetState {
  const buckets: TokenBuckets = {
    uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  }
  const root = sessions.find(session => session.header.id === rootId)
  if (root === undefined) return budgetFromBuckets(runId, limitTokens, buckets, 0)
  let counted = 0
  for (const session of sessions) {
    const own = ownRunTokens(session, root, runId)
    if (own === undefined) continue
    counted++
    buckets.uncachedInputTokens += own.uncachedInputTokens
    buckets.outputTokens += own.outputTokens
    buckets.cacheReadTokens += own.cacheReadTokens
    buckets.cacheWriteTokens += own.cacheWriteTokens
  }
  return budgetFromBuckets(runId, limitTokens, buckets, counted)
}

function budgetFromBuckets(
  runId: string,
  limitTokens: number,
  buckets: TokenBuckets,
  sessions: number,
): TokenBudgetState {
  const usedTokens = buckets.uncachedInputTokens + buckets.outputTokens
    + buckets.cacheReadTokens + buckets.cacheWriteTokens
  return {
    ...buckets,
    runId,
    limitTokens,
    usedTokens,
    remainingTokens: Math.max(0, limitTokens - usedTokens),
    exhausted: usedTokens >= limitTokens,
    sessions,
  }
}

/** Pure live-session fold, exported for focused tests and immediate usage-event enforcement. */
export function liveTokenBudgetState(
  sessions: readonly RuntimeSession[],
  rootId: string,
  runId: string,
  limitTokens: number,
): TokenBudgetState {
  const headers = new Map(sessions.map(session => [session.header.id, session.header]))
  return sumBudget(
    rootId,
    runId,
    limitTokens,
    sessions.filter(session => isDescendantOf(session.header, rootId, headers)),
  )
}

async function durableTokenBudgetState(
  ctx: SupervisorRuntimeContext,
  rootId: string,
  runId: string,
  limitTokens: number,
  cache: Map<string, { revision: string; session: RuntimeSession }>,
): Promise<TokenBudgetState> {
  const live = new Map(ctx.sessions.list().map(session => [session.header.id, session]))
  const snapshots = await ctx.sessionPersistence.listSnapshots()
  const headers = new Map(snapshots.map(snapshot => [snapshot.header.id, snapshot.header]))
  for (const session of live.values()) headers.set(session.header.id, session.header)
  const related = [...headers.values()].filter(header => isDescendantOf(header, rootId, headers))
  const revisions = new Map(snapshots.map(snapshot => [snapshot.header.id, snapshot.revision]))
  const durableSessions: RuntimeSession[] = []
  for (const header of related) {
    const resident = live.get(header.id)
    if (resident !== undefined) {
      durableSessions.push(resident)
      continue
    }
    const revision = revisions.get(header.id)
    if (revision === undefined) continue
    let cached = cache.get(header.id)
    if (cached?.revision !== revision) {
      const inspected = await ctx.sessionPersistence.inspect(header.id)
      cached = {
        revision,
        session: { header: inspected.meta, events: inspected.events },
      }
      cache.set(header.id, cached)
    }
    durableSessions.push(cached.session)
  }
  for (const id of cache.keys()) {
    if (!headers.has(id)) cache.delete(id)
  }
  return sumBudget(rootId, runId, limitTokens, durableSessions)
}

async function budgetRootSession(
  ctx: SupervisorRuntimeContext,
  sessionId: string,
): Promise<RuntimeSession | undefined> {
  const resident = ctx.sessions.list().find(session => session.header.id === sessionId)
  if (resident !== undefined) return resident
  const snapshots = await ctx.sessionPersistence.listSnapshots()
  if (!snapshots.some(snapshot => snapshot.header.id === sessionId)) return undefined
  const inspected = await ctx.sessionPersistence.inspect(sessionId)
  return { header: inspected.meta, events: inspected.events }
}

/** Read-only Host projection of the same durable run-tree accounting used by the guards. */
export async function tokenBudgetStateForRun(
  ctx: SupervisorRuntimeContext,
  request: TokenBudgetStateRequest,
): Promise<TokenBudgetStateReceipt> {
  if (request.schemaVersion !== 1 || request.sessionId.trim() === '' || !UUID_PATTERN.test(request.runId)) {
    throw new Error('invalid token budget state request')
  }
  const root = await budgetRootSession(ctx, request.sessionId)
  if (root === undefined) throw new Error(`DSH session not found: ${request.sessionId}`)
  const boundary = ownTaskBoundaries(root).findLast(candidate => candidate.identity.schemaVersion === 2
    && candidate.identity.sessionId === request.sessionId
    && candidate.identity.runId === request.runId)
  if (boundary?.identity.tokenBudget === undefined) {
    throw new Error(`run ${request.runId} has no Host-enforced token budget`)
  }
  const state = await durableTokenBudgetState(
    ctx,
    request.sessionId,
    request.runId,
    boundary.identity.tokenBudget,
    new Map(),
  )
  return {
    schemaVersion: 1,
    sessionId: request.sessionId,
    ...state,
    coverage: 'run_tree',
    enforcement: 'DSH_HOST_RUNTIME',
    overshootBound: 'IN_FLIGHT_MODEL_RESPONSES',
  }
}

/** Register a bounded Host-local endpoint for budget observability without a model call. */
export function registerTokenBudgetStateRoute(
  webServer: SupervisorRuntimeContext['webServer'],
  runtime: SupervisorRuntimeContext,
): () => void {
  return webServer.register({
    kind: 'exact',
    path: TOKEN_BUDGET_STATE_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!authorizeSupervisorRequest(req, res)) return
      let rpcId = 'invalid'
      const send = (result: unknown): void => {
        if (res.destroyed) return
        const body = JSON.stringify({ type: 'server-response', rpcId, result })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
      }
      try {
        if (req.method !== 'POST') throw new Error('token budget state requires POST')
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > 16 * 1024) throw new Error('token budget state body is too large')
          chunks.push(buffer)
        }
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        if (envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string'
          || envelope.method !== 'dsh-gate.budget-state') {
          throw new Error('invalid token budget state request envelope')
        }
        rpcId = envelope.rpcId
        const value = await tokenBudgetStateForRun(runtime, envelope.payload as TokenBudgetStateRequest)
        send({ ok: true, value })
      } catch (error) {
        send({ ok: false, error: {
          code: 'BUDGET_STATE_FAILED',
          message: error instanceof Error ? error.message : String(error),
        } })
      }
    },
  })
}

const BUDGET_REASON = 'dsh-gate:token-budget-exhausted'
const BUDGET_REQUEST_REASON = 'dsh-gate:token-budget-request-rejected'
const BUDGET_ACCOUNTING_REASON = 'dsh-gate:token-budget-accounting-failed'

function runBudgetKey(rootId: string, runId: string): string {
  return `${rootId}\u0000${runId}`
}

function requestBudgetKey(sessionId: string, turn: number, step: number): string {
  return `${sessionId}\u0000${turn}\u0000${step}`
}

function reservedTokens(reservations: readonly DurableBudgetReservation[], except?: string): number {
  let total = 0
  for (const reservation of reservations) {
    const key = requestBudgetKey(reservation.requestSessionId, reservation.turn, reservation.step)
    if (key !== except) total += reservation.inputTokens + reservation.outputTokens
  }
  return total
}

function durableReservationId(reservation: DurableBudgetReservation): string {
  return `${runBudgetKey(reservation.rootSessionId, reservation.runId)}\u0000${requestBudgetKey(
    reservation.requestSessionId, reservation.turn, reservation.step,
  )}`
}

function durableReservationStatus(
  events: readonly RuntimeEvent[],
  reservation: DurableBudgetReservation,
): 'ambiguous' | 'never_dispatched' | 'settled' {
  const startIndex = events.findIndex(event => event.type === 'step/start'
    && (event.data as { turn?: unknown; step?: unknown }).turn === reservation.turn
    && (event.data as { turn?: unknown; step?: unknown }).step === reservation.step)
  if (startIndex < 0) return 'never_dispatched'
  for (const event of events.slice(startIndex + 1)) {
    const data = event.data as { turn?: unknown; step?: unknown }
    if (data.turn !== reservation.turn) continue
    if (usageSample(event)?.key === `${String(reservation.turn)}:${String(reservation.step)}`) return 'settled'
    if (event.type === 'step/end' && data.step === reservation.step) return 'settled'
    if (event.type === 'turn/end') return 'settled'
  }
  return 'ambiguous'
}

async function reconcileDurableReservations(
  runtime: SupervisorRuntimeContext,
  ledger: BudgetReservationLedger,
  rootSessionId: string,
  runId: string,
  active: ReadonlySet<string>,
): Promise<DurableBudgetReservation[]> {
  const reservations = await ledger.list(rootSessionId, runId)
  const snapshots = await runtime.sessionPersistence.listSnapshots()
  const durableIds = new Set(snapshots.map(snapshot => snapshot.header.id))
  const retained: DurableBudgetReservation[] = []
  for (const reservation of reservations) {
    if (active.has(durableReservationId(reservation))) {
      retained.push(reservation)
      continue
    }
    if (!durableIds.has(reservation.requestSessionId)) {
      await ledger.settle(reservation)
      continue
    }
    const inspected = await runtime.sessionPersistence.inspect(reservation.requestSessionId)
    if (durableReservationStatus(inspected.events, reservation) === 'ambiguous') retained.push(reservation)
    else await ledger.settle(reservation)
  }
  return retained
}

/** Minimal keyed mutex used only for short Host-side admission accounting sections. */
async function withKeyedLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve()
  let release = (): void => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const tail = prior.then(() => held)
  locks.set(key, tail)
  await prior
  try {
    return await task()
  } finally {
    release()
    if (locks.get(key) === tail) locks.delete(key)
  }
}

function cancelRun(ctx: SupervisorRuntimeContext, rootId: string, runId: string, reason: string): void {
  const sessions = ctx.sessions.list()
  const headers = new Map(sessions.map(session => [session.header.id, session.header]))
  const related = sessions.filter(session => isDescendantOf(session.header, rootId, headers))
  const root = related.find(session => session.header.id === rootId)
  if (root === undefined) return
  for (const candidate of ctx.agents.list()) {
    if (related.some(session => session.header.id === candidate.session.header.id)
      && ownRunTokens(candidate.session, root, runId) !== undefined) {
      candidate.cancel({ kind: 'hook', reason })
    }
  }
}

function budgetIdentityForSession(
  session: RuntimeSession,
  sessions: readonly RuntimeSession[],
): TaskIdentity | undefined {
  const headers = new Map(sessions.map(candidate => [candidate.header.id, candidate.header]))
  const candidates = sessions.flatMap((root) => {
    if (!isDescendantOf(session.header, root.header.id, headers)) return []
    const boundary = latestTaskIdentityBoundary(root.events)
    if (boundary?.identity.schemaVersion !== 2
      || boundary.identity.sessionId !== root.header.id
      || boundary.identity.runId === undefined
      || boundary.identity.tokenBudget === undefined
      || ownRunTokens(session, root, boundary.identity.runId) === undefined) return []
    return [{ identity: boundary.identity, time: boundary.boundaryTime ?? -1, seq: boundary.boundarySeq }]
  })
  candidates.sort((left, right) => left.time - right.time || left.seq - right.seq)
  return candidates.at(-1)?.identity
}

function budgetReason(state: TokenBudgetState): string {
  return `${BUDGET_REASON};runId=${state.runId};used=${state.usedTokens};limit=${state.limitTokens}`
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

export function reportedFailurePayloadError(args: {
  failureSignature: string
  summary: string
  hypothesis: string
}): string | undefined {
  if (args.failureSignature.length > HANDOFF_FAILURE_SIGNATURE_LIMIT) {
    return `supervisor_report_failure failureSignature exceeds ${HANDOFF_FAILURE_SIGNATURE_LIMIT} characters`
  }
  if (args.summary.length > REPORTED_FAILURE_SUMMARY_LIMIT) {
    return `supervisor_report_failure summary exceeds ${REPORTED_FAILURE_SUMMARY_LIMIT} characters`
  }
  if (args.hypothesis.length > REPORTED_FAILURE_HYPOTHESIS_LIMIT) {
    return `supervisor_report_failure hypothesis exceeds ${REPORTED_FAILURE_HYPOTHESIS_LIMIT} characters`
  }
  return undefined
}

/** Failure recovery authority belongs only to the currently addressed Root session. */
export function reportedFailureIdentityError(
  events: readonly { type: string; seq?: number; time?: number; data: unknown }[],
  currentSessionId: string,
): string | undefined {
  const identity = latestTaskIdentity(events)
  if (identity === undefined) return 'supervisor_report_failure requires a valid supervised task packet'
  if (identity.sessionId !== currentSessionId) {
    return `supervisor_report_failure is Root-only; task packet addresses ${identity.sessionId}, current session is ${currentSessionId}`
  }
  return undefined
}

/** Install Host-owned live and post-restart token-budget enforcement. */
export function installDirectChildAuthorityGuards(
  runtime: SupervisorRuntimeContext,
  options: { directChildToolNames?: readonly string[] } = {},
): void {
  const toolNames = new Set(options.directChildToolNames ?? ['subagent', 'subagent_fork'])
  const locks = new Map<string, Promise<void>>()
  const pendingByRun = new Map<string, Set<symbol>>()
  const runByExecution = new Map<symbol, string>()

  const release = (token: symbol): void => {
    const runKey = runByExecution.get(token)
    if (runKey === undefined) return
    runByExecution.delete(token)
    const pending = pendingByRun.get(runKey)
    pending?.delete(token)
    if (pending?.size === 0) pendingByRun.delete(runKey)
  }

  runtime.on('tools/result', (execution) => { release(execution.token) })
  runtime.on('tools/pre-execute', async (execution, next) => {
    const delegated = await next()
    if (delegated.kind !== 'allow' || !toolNames.has(execution.name) || execution.agent === undefined) {
      return delegated
    }
    const { session } = execution.agent
    const boundary = latestTaskIdentityBoundary(session.events)
    const identity = boundary?.identity
    if (boundary === undefined
      || identity?.schemaVersion !== 2
      || identity.runId === undefined
      || identity.sessionId !== session.header.id
      || identity.maxDirectChildren === undefined) return delegated
    if (boundary.boundaryTime === undefined) {
      return { kind: 'deny', reason: `dsh-gate:direct-child-accounting-failed;runId=${identity.runId};error=missing-task-boundary-time` }
    }

    const { boundaryTime } = boundary
    const { maxDirectChildren } = identity
    const runKey = runBudgetKey(identity.sessionId, identity.runId)
    return withKeyedLock(locks, runKey, async () => {
      try {
        const snapshots = await runtime.sessionPersistence.listSnapshots()
        const headers = new Map<string, RuntimeSessionHeader>()
        for (const snapshot of snapshots) headers.set(snapshot.header.id, snapshot.header)
        for (const candidate of runtime.sessions.list()) headers.set(candidate.header.id, candidate.header)
        const created = [...headers.values()].filter(header => header.parentSession === identity.sessionId
          && header.createdAt !== undefined && header.createdAt >= boundaryTime).length
        const pending = pendingByRun.get(runKey) ?? new Set<symbol>()
        if (created + pending.size >= maxDirectChildren) {
          return {
            kind: 'deny' as const,
            reason: `dsh-gate:direct-child-limit;runId=${identity.runId};used=${created + pending.size};limit=${maxDirectChildren}`,
          }
        }
        pending.add(execution.token)
        pendingByRun.set(runKey, pending)
        runByExecution.set(execution.token, runKey)
        return delegated
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          kind: 'deny' as const,
          reason: `dsh-gate:direct-child-accounting-failed;runId=${identity.runId};error=${message.slice(0, 256)}`,
        }
      }
    })
  })
}

export function installTokenBudgetGuards(
  runtime: SupervisorRuntimeContext,
  options: {
    maxReservedOutputTokensPerRequest?: number
    reservationLedger?: BudgetReservationLedger
  } = {},
): void {
  const maxReservedOutputTokensPerRequest = options.maxReservedOutputTokensPerRequest ?? 8_192
  const reservationLedger = options.reservationLedger ?? new FileBudgetReservationLedger()
  const durableUsageCache = new Map<string, { revision: string; session: RuntimeSession }>()
  const promptAssemblies = new WeakMap<RuntimeAgent, PromptAssembly>()
  const locks = new Map<string, Promise<void>>()
  const activeReservations = new Set<string>()
  const reservationGenerations = new Map<string, number>()
  const reservationWaiters = new Map<string, Set<() => void>>()

  const notifyReservationChange = (runKey: string): void => {
    reservationGenerations.set(runKey, (reservationGenerations.get(runKey) ?? 0) + 1)
    const waiters = reservationWaiters.get(runKey)
    if (waiters === undefined) return
    reservationWaiters.delete(runKey)
    for (const wake of waiters) wake()
  }

  const settleEventReservations = async (session: RuntimeSession, event: RuntimeEvent): Promise<void> => {
    if (event.type !== 'assistant/message' && event.type !== 'step/end' && event.type !== 'turn/end') return
    const packet = budgetIdentityForSession(session, runtime.sessions.list())
    if (packet?.schemaVersion !== 2 || packet.runId === undefined) return
    const data = event.data as { turn?: unknown; step?: unknown }
    if (typeof data.turn !== 'number') return
    const runKey = runBudgetKey(packet.sessionId, packet.runId)
    try {
      if (!await runtime.sessions.flush(session)) return
      const durable = await reservationLedger.list(packet.sessionId, packet.runId)
      const matches = durable.filter(reservation => reservation.requestSessionId === session.header.id
        && reservation.turn === data.turn
        && (typeof data.step !== 'number' || reservation.step === data.step))
      for (const reservation of matches) {
        await reservationLedger.settle(reservation)
        activeReservations.delete(durableReservationId(reservation))
      }
      if (matches.length > 0) notifyReservationChange(runKey)
    } catch {
      // Fail closed: a reservation remains charged until a later durable
      // checkpoint or restart reconciliation proves the request settled.
    }
  }

  const waitForReservation = async (runKey: string, generation: number, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    if ((reservationGenerations.get(runKey) ?? 0) !== generation) return
    await new Promise<void>((resolve, reject) => {
      const waiters = reservationWaiters.get(runKey) ?? new Set<() => void>()
      reservationWaiters.set(runKey, waiters)
      const settle = (): void => {
        signal.removeEventListener('abort', abort)
        waiters.delete(settle)
        if (waiters.size === 0 && reservationWaiters.get(runKey) === waiters) {
          reservationWaiters.delete(runKey)
        }
        resolve()
      }
      const abort = (): void => {
        waiters.delete(settle)
        if (waiters.size === 0 && reservationWaiters.get(runKey) === waiters) {
          reservationWaiters.delete(runKey)
        }
        reject(signal.reason)
      }
      waiters.add(settle)
      signal.addEventListener('abort', abort, { once: true })
      if ((reservationGenerations.get(runKey) ?? 0) !== generation) settle()
    })
  }

  runtime.on('system-prompt/assemble', async (_assembly, context, next) => {
    const resolved = await next()
    if (context.agent !== undefined) promptAssemblies.set(context.agent, resolved)
    return resolved
  })

  // The guard lives in the independently owned Host process, so loss of the
  // MCP/Codex client cannot reset or disable it. A stream usage sample gives an
  // immediate live-tree brake; every pre-step also reconciles persisted cold
  // descendants so Host restart and completed children remain accounted for.
  runtime.on('session/event', (session, event) => {
    void settleEventReservations(session, event)
    if (usageSample(event) === undefined) return
    const sessions = runtime.sessions.list()
    const packet = budgetIdentityForSession(session, sessions)
    if (packet?.schemaVersion !== 2 || packet.runId === undefined || packet.tokenBudget === undefined) return
    const state = liveTokenBudgetState(sessions, packet.sessionId, packet.runId, packet.tokenBudget)
    if (state.exhausted) cancelRun(runtime, packet.sessionId, packet.runId, budgetReason(state))
  })

  runtime.on('agent/pre-step', async ({ agent }, next) => {
    const packet = budgetIdentityForSession(agent.session, runtime.sessions.list())
    if (packet?.schemaVersion !== 2 || packet.runId === undefined || packet.tokenBudget === undefined) return next()
    try {
      const state = await durableTokenBudgetState(
        runtime, packet.sessionId, packet.runId, packet.tokenBudget, durableUsageCache,
      )
      if (!state.exhausted) return next()
      cancelRun(runtime, packet.sessionId, packet.runId, budgetReason(state))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      cancelRun(
        runtime,
        packet.sessionId,
        packet.runId,
        `${BUDGET_ACCOUNTING_REASON};runId=${packet.runId};error=${message.slice(0, 256)}`,
      )
    }
    return { kind: 'reject' }
  })

  // Request errors settle only after the loop appends and checkpoints the
  // corresponding step/end. Releasing here would lose the reservation if the
  // Host crashed between this hook and that durable boundary.
  runtime.on('agent/request-error', async (_payload, next) => next())

  runtime.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const proposed = await next()
    const packet = budgetIdentityForSession(agent.session, runtime.sessions.list())
    if (packet?.schemaVersion !== 2 || packet.runId === undefined || packet.tokenBudget === undefined) return proposed
    const assembly = promptAssemblies.get(agent)
    if (assembly === undefined) {
      cancelRun(runtime, packet.sessionId, packet.runId,
        `${BUDGET_ACCOUNTING_REASON};runId=${packet.runId};error=missing-prompt-assembly`)
      return proposed
    }

    const { sessionId: rootId, runId, tokenBudget } = packet
    const runKey = runBudgetKey(rootId, runId)
    const requestKey = requestBudgetKey(agent.session.header.id, turn, step)
    const system = renderPrompt(assembly)
    while (true) {
      const admission = await withKeyedLock(locks, runKey, async () => {
        try {
          const state = await durableTokenBudgetState(
            runtime, rootId, runId, tokenBudget, durableUsageCache,
          )
          const requestHeader: RuntimeRequestHeader = {
            config: proposed,
            ...system === '' ? {} : { system },
            ...assembly.tools.length === 0 ? {} : { tools: assembly.tools },
          }
          const inputTokens = Math.max(0, Math.ceil(runtime.tokenMeter.measure(agent.session, requestHeader).totalTokens))
          const runReservations = await reconcileDurableReservations(
            runtime, reservationLedger, rootId, runId, activeReservations,
          )
          const existing = runReservations.find(reservation =>
            requestBudgetKey(reservation.requestSessionId, reservation.turn, reservation.step) === requestKey)
          const otherReserved = reservedTokens(runReservations, requestKey)
          const actualRemaining = state.remainingTokens
          if (state.exhausted) {
            return { kind: 'exhausted' as const, state }
          }
          if (actualRemaining <= inputTokens) {
            return { kind: 'insufficient' as const, state, inputTokens }
          }
          if (existing !== undefined) {
            activeReservations.add(durableReservationId(existing))
            return { kind: 'admitted' as const, outputTokens: existing.outputTokens }
          }
          const available = actualRemaining - otherReserved
          if (available <= inputTokens) {
            return {
              kind: 'wait' as const,
              generation: reservationGenerations.get(runKey) ?? 0,
            }
          }
          const requestedOutput = proposed.maxTokens === undefined
            ? maxReservedOutputTokensPerRequest
            : Math.max(1, Math.floor(proposed.maxTokens))
          const outputTokens = Math.min(requestedOutput, maxReservedOutputTokensPerRequest, available - inputTokens)
          const reservation: DurableBudgetReservation = {
            schemaVersion: 1,
            rootSessionId: rootId,
            runId,
            requestSessionId: agent.session.header.id,
            turn,
            step,
            inputTokens,
            outputTokens,
            createdAt: Date.now(),
          }
          await reservationLedger.reserve(reservation)
          activeReservations.add(durableReservationId(reservation))
          return { kind: 'admitted' as const, outputTokens }
        } catch (error) {
          return { kind: 'error' as const, error }
        }
      })

      if (admission.kind === 'admitted') return { ...proposed, maxTokens: admission.outputTokens }
      if (admission.kind === 'wait') {
        await waitForReservation(runKey, admission.generation, signal)
        continue
      }
      if (admission.kind === 'exhausted') {
        cancelRun(runtime, rootId, runId, budgetReason(admission.state))
        return proposed
      }
      if (admission.kind === 'insufficient') {
        cancelRun(runtime, rootId, runId,
          `${BUDGET_REQUEST_REASON};runId=${runId};used=${admission.state.usedTokens};limit=${tokenBudget};remaining=${admission.state.remainingTokens};requiredInput=${admission.inputTokens}`)
        return proposed
      }
      const message = admission.error instanceof Error ? admission.error.message : String(admission.error)
      cancelRun(runtime, rootId, runId,
        `${BUDGET_ACCOUNTING_REASON};runId=${runId};error=${message.slice(0, 256)}`)
      return proposed
    }
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  requiredHostToken()
  const resolved = Config(config) as Required<Config>
  const directChildToolNames = [...new Set(resolved.directChildToolNames.map(value => value.trim()))]
  if (directChildToolNames.length === 0 || directChildToolNames.some(value => value.length === 0)) {
    throw new Error('dsh-gate supervisor tools: directChildToolNames must contain at least one non-empty tool name')
  }
  const runtime = ctx as unknown as SupervisorRuntimeContext
  const admissionRuntime: TaskAdmissionRuntime = {
    agents: runtime.agents as unknown as TaskAdmissionRuntime['agents'],
    sessions: runtime.sessions as unknown as TaskAdmissionRuntime['sessions'],
    sessionPersistence: runtime.sessionPersistence as unknown as TaskAdmissionRuntime['sessionPersistence'],
    apiProxy: runtime.apiProxy,
    policyDefaults: {
      sandboxMode: runtime.sandboxPolicy.defaultMode,
      approvalPolicy: runtime.approval.config.policy ?? 'ask',
    },
  }
  const recovery = new HostRecoveryCoordinator(admissionRuntime)
  const gitBaselines = new FileGitBaselineStore()
  const admission = new TaskAdmissionCoordinator(
    admissionRuntime,
    undefined,
    recovery,
    gitBaselines,
  )
  ctx.effect(() => registerTaskAdmissionRoute(
    runtime.webServer,
    admission,
  ), 'dsh-gate task admission route')
  ctx.effect(() => registerRecoveryCapsuleRoute(
    runtime.webServer,
    recovery,
  ), 'dsh-gate recovery capsule route')
  ctx.effect(() => registerTokenBudgetStateRoute(
    runtime.webServer,
    runtime,
  ), 'dsh-gate token budget state route')
  ctx.effect(() => registerSupervisorDescriptorRoute(
    runtime.webServer,
  ), 'dsh-gate supervisor descriptor route')
  installDirectChildAuthorityGuards(runtime, { directChildToolNames })
  installTokenBudgetGuards(runtime, {
    maxReservedOutputTokensPerRequest: resolved.maxReservedOutputTokensPerRequest,
  })

  ctx.systemPrompt.section({
    name: 'tool:supervisor-handoff',
    order: 195,
    text: 'You are supervised by an external runtime. Before ending a task, call '
      + '`supervisor_handoff` exactly once. For a schemaVersion 2 packet, pass its sessionId, runId, and completionToken; '
      + 'for a legacy schemaVersion 1 packet, pass taskId and completionToken. '
      + 'Keep `supervisor_handoff.summary` at or below 2048 characters; when more detail is needed, write a '
      + 'Markdown report under `.dsh-handoff/<runId>/` inside the session cwd, include its relative path in '
      + '`artifacts`, and reference it from the concise summary. Keep the file list, verification claims, blocker, '
      + 'failure signature, hypotheses, and artifact manifest compact; their schemas are also bounded. '
      + 'Use `supervisor_progress` only for bounded milestone changes; it never ends the turn. When a decision is needed, '
      + 'include the structured decision category, impact, blocking state, request, options, and recommendation. '
      + '`needsSupervisor` is a migration hint; the runtime policy decides whether the request interrupts immediately or '
      + 'is folded into the normal progress cadence. Never claim pre-authorization yourself. '
      + 'When the task packet grants `authority.maxDirectChildren`, you may create children within that cap without asking again; the Host rejects starts beyond the durable run limit. DSH native maxDepth permits Root-to-child delegation and forbids grandchildren. '
      + 'If you create children, wait for their durable terminal boundaries, integrate the Host-delivered reports in Root, and only then publish the final Root handoff; its turn end must be strictly newer than the last child terminal boundary. '
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
      milestone: { type: 'string', required: true },
      nextAction: { type: 'string', required: true },
      currentHypothesis: { type: 'string' },
      risk: { type: 'string' },
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
          request: { type: 'string', required: true },
          options: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string' },
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
          workspaceChanges: workspaceChangesOutput(),
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('supervisor_progress requires an agent-owned session')
      const events = exec.agent.session.events
      const payloadError = progressPayloadError(args)
      if (payloadError !== undefined) throw new Error(payloadError)
      const identityError = progressIdentityError(events, args)
      if (identityError !== undefined) throw new Error(identityError)
      const decision = supervisorProgressDecision(events, args)
      if (!decision.accepted) return { accepted: false as const, reason: decision.reason }
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
      const identity = latestTaskIdentity(events)
      let workspaceChanges: WorkspaceChangesEvidence | undefined
      if (identity?.writerMode === 'writer' && identity.runId !== undefined) {
        const cwd = exec.agent.session.header.cwd
        if (cwd === undefined) throw new Error('supervisor_progress writer session has no authoritative cwd')
        workspaceChanges = boundedWorkspaceChanges(await gitBaselines.verify({
          sessionId: identity.sessionId,
          runId: identity.runId,
          cwd,
        }))
      }
      return {
        accepted: true as const,
        progress,
        ...workspaceChanges === undefined ? {} : { workspaceChanges },
      }
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
      if (exec.agent === undefined) throw new Error('supervisor_report_failure requires an agent-owned session')
      const payloadError = reportedFailurePayloadError(args)
      if (payloadError !== undefined) throw new Error(payloadError)
      const events = exec.agent.session.events
      const identityError = reportedFailureIdentityError(events, exec.agent.session.header.id)
      if (identityError !== undefined) throw new Error(identityError)
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
      + 'the corresponding turn/end event. A completed handoff cannot contain failed or not-run verification; an empty '
      + 'verification list remains protocol-complete but externally unverified. All model-facing fields and collection sizes are bounded; put complete detail '
      + 'in an admitted .dsh-handoff/<runId>/ report instead of expanding the tool payload.',
    parameters: {
      taskId: { type: 'string', description: 'Legacy schemaVersion 1 session/task id.' },
      sessionId: { type: 'string', description: 'SchemaVersion 2 durable DSH session id.' },
      runId: { type: 'string', description: 'SchemaVersion 2 supervised run id.' },
      completionToken: { type: 'string', required: true },
      status: { type: 'string', required: true, enum: [...HANDOFF_STATUSES] },
      stage: { type: 'string', required: true },
      summary: { type: 'string', required: true },
      files: {
        type: 'array', required: true,
        items: { type: 'string' },
      },
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
      attemptedHypotheses: {
        type: 'array',
        items: { type: 'string' },
      },
      artifacts: {
        type: 'array', required: true,
        items: { type: 'string' },
      },
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
          workspaceChanges: workspaceChangesOutput(),
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
      const payloadError = handoffPayloadError(args)
      if (payloadError !== undefined) throw new Error(payloadError)
      const identity = latestTaskIdentity(exec.agent.session.events)
      let gitValidation
      if (identity?.writerMode === 'writer') {
        if (exec.agent.session.header.cwd === undefined) {
          throw new Error('supervisor_handoff writer session has no authoritative cwd')
        }
        gitValidation = await gitBaselines.verify({
          sessionId: identity.sessionId,
          runId: identity.runId ?? args.runId ?? '',
          cwd: exec.agent.session.header.cwd,
        })
        if (gitValidation.outOfScopePaths.length > 0) {
          throw new Error(`supervisor_handoff found out-of-scope writer changes: ${gitValidation.outOfScopePaths.join(', ')}`)
        }
      }
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
      return {
        accepted: true as const,
        handoff,
        artifacts,
        ...gitValidation === undefined ? {} : { workspaceChanges: boundedWorkspaceChanges(gitValidation) },
      }
    },
  }))
}
