import { z } from 'zod'
import { DECISION_CATEGORIES, DECISION_IMPACTS } from '@dsh-gate/decision-policy'

export const failureKindSchema = z.enum([
  'WORKER_FAILED', 'HOST_FAILED', 'MISSING_HANDOFF', 'PROTOCOL_ERROR',
])
export type FailureKind = z.infer<typeof failureKindSchema>

export const workerStateSchema = z.enum(['RUNNING', 'IDLE', 'UNKNOWN'])
export type WorkerState = z.infer<typeof workerStateSchema>

export const HANDOFF_STAGE_LIMIT = 128
export const HANDOFF_SUMMARY_LIMIT = 2_048
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
export const FAILURE_MESSAGE_LIMIT = 2_048
export const INTERACTION_ID_LIMIT = 512
export const APPROVAL_TOOL_NAME_LIMIT = 256
export const APPROVAL_REASON_LIMIT = 1_024
export const QUESTION_COUNT_LIMIT = 5
export const QUESTION_ID_LIMIT = 256
export const QUESTION_TEXT_LIMIT = 1_024
export const QUESTION_DETAIL_LIMIT = 1_024
export const QUESTION_HEADER_LIMIT = 256
export const QUESTION_OPTIONS_LIMIT = 10
export const QUESTION_OPTION_LABEL_LIMIT = 256
export const QUESTION_OPTION_DESCRIPTION_LIMIT = 256
export const RECOVERY_CAPSULE_MAX_BYTES = 16_384
export const UNCERTAIN_EFFECTS_LIMIT = 16

export const verificationSchema = z.object({
  command: z.string().max(HANDOFF_VERIFICATION_COMMAND_LIMIT),
  outcome: z.enum(['passed', 'failed', 'not_run']),
  summary: z.string().max(HANDOFF_VERIFICATION_SUMMARY_LIMIT),
})

export const artifactSchema = z.object({
  path: z.string().max(HANDOFF_ARTIFACT_PATH_LIMIT),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

const tokenDeltaSchema = z.object({
  uncachedInputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
})

export const telemetryTokenUsageSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

export const telemetrySessionStatsSchema = z.object({
  turns: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  llmMs: z.number().nonnegative(),
  toolMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative(),
  ttftSteps: z.number().int().nonnegative(),
  decodeMs: z.number().nonnegative(),
  decodeTokens: z.number().nonnegative(),
}).strict()

export const telemetrySubagentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('one-shot'), label: z.string().max(256).optional(), seq: z.number().int().nonnegative() }).strict(),
  z.object({ mode: z.literal('continuable'), label: z.string().max(256), seq: z.number().int().nonnegative() }).strict(),
]).nullable()

/** Bounded summary of edit/write and targeted verification activity since the prior observation. */
export const editWriteActivitySchema = z.object({
  /** Complete only when every observed tool is classifiable for project mutation coverage. */
  coverage: z.enum(['complete', 'partial']),
  edits: z.object({
    /** Distinct project files touched by successful mutating tool calls. */
    total: z.number().int().nonnegative(),
    /** Bounded sample of those file paths, project-focused and sanitized. */
    files: z.array(z.string().max(200)).max(10),
  }),
  verification: z.object({
    /** Distinct targeted verification commands attempted (for example `pnpm verify`). */
    total: z.number().int().nonnegative(),
    /** Bounded sample of compact command labels. */
    commands: z.array(z.string().max(60)).max(5),
    /** Runtime-correlated tool outcomes, distinct from worker handoff claims. */
    evidence: z.array(z.object({
      command: z.string().max(60),
      outcome: z.enum(['passed', 'failed', 'pending']),
    })).max(5),
  }),
})
export type EditWriteActivity = z.infer<typeof editWriteActivitySchema>

/** Task-scope project activity attached to terminal observations. */
export const projectActivitySchema = editWriteActivitySchema.extend({
  steps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolCallsByName: z.record(z.string().max(64), z.number().int().nonnegative())
    .refine(value => Object.keys(value).length <= 32),
  tokenUsage: tokenDeltaSchema,
})
export type ProjectActivity = z.infer<typeof projectActivitySchema>

export const progressHeartbeatSchema = z.object({
  fromAsOfSeq: z.number().int().min(-1),
  toAsOfSeq: z.number().int().min(-1),
  observedEvents: z.number().int().nonnegative(),
  steps: z.object({
    completed: z.number().int().nonnegative(),
    delta: z.number().int().nonnegative(),
  }),
  tools: z.object({
    totalCalls: z.number().int().nonnegative(),
    deltaCalls: z.number().int().nonnegative(),
    deltaByName: z.record(z.string().max(64), z.number().int().nonnegative())
      .refine(value => Object.keys(value).length <= 32),
  }),
  tokenDelta: tokenDeltaSchema,
  lastActivity: z.object({
    seq: z.number().int().min(-1),
    time: z.number(),
    kind: z.enum(['turn', 'step', 'model_stream', 'model_message', 'tool_call', 'tool_result']),
    step: z.number().int().nonnegative().optional(),
    toolName: z.string().max(64).optional(),
  }).optional(),
  projectActivity: editWriteActivitySchema,
})
export type ProgressHeartbeat = z.infer<typeof progressHeartbeatSchema>

export const workerDecisionRequestSchema = z.object({
  category: z.enum(DECISION_CATEGORIES),
  impact: z.enum(DECISION_IMPACTS),
  blocking: z.boolean(),
  requiresHuman: z.boolean().optional(),
  request: z.string().min(1).max(512),
  options: z.array(z.string().min(1).max(256)).max(5).optional(),
  recommendation: z.string().min(1).max(512).optional(),
}).strict()

export const decisionOutcomeSchema = z.object({
  timing: z.enum(['cadence', 'immediate']),
  audience: z.enum(['none', 'supervisor', 'human']),
  action: z.enum([
    'CONTINUE_WAIT', 'SURFACE_PROGRESS', 'RESOLVE_INTERACTION', 'REVIEW_WORKER_REQUEST',
    'ASK_HUMAN', 'ACCEPT_TERMINAL', 'REVIEW_FAILURE', 'QUEUE_CONTINUATION',
  ]),
  reasonCode: z.string().max(128),
  policyVersion: z.string().max(128),
  matchedRuleId: z.string().max(128),
  protocolInvariant: z.boolean(),
}).strict()

/** Bounded worker-supplied semantic context; quantitative fields stay runtime-derived. */
export const supervisorProgressSchema = z.object({
  sessionId: z.string().min(1).max(512),
  runId: z.string().min(1).max(512),
  phase: z.enum(['investigating', 'implementing', 'verifying', 'recovering']),
  milestone: z.string().min(1).max(512),
  nextAction: z.string().min(1).max(512),
  currentHypothesis: z.string().max(1_024).optional(),
  risk: z.string().max(512).optional(),
  needsSupervisor: z.boolean(),
  decision: workerDecisionRequestSchema.optional(),
}).strict()
export type SupervisorProgress = z.infer<typeof supervisorProgressSchema>

export const uncertainEffectLedgerSchema = z.object({
  source: z.literal('DURABLE_EVENT_FOLD'),
  total: z.number().int().nonnegative(),
  entries: z.array(z.object({
    sessionId: z.string().min(1).max(512).optional(),
    callId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(64),
    category: z.enum(['FILESYSTEM_MUTATION', 'COMMAND_OR_EXTERNAL_EFFECT', 'UNKNOWN_TOOL_EFFECT']),
    callSeq: z.number().int().min(-1),
    step: z.number().int().nonnegative().optional(),
    reason: z.literal('NO_DURABLE_TOOL_RESULT'),
    replayGuidance: z.literal('RECONCILE_BEFORE_RETRY'),
  }).strict()).max(UNCERTAIN_EFFECTS_LIMIT),
  truncated: z.boolean(),
}).strict()
export type UncertainEffectLedger = z.infer<typeof uncertainEffectLedgerSchema>

const recoveryActivitySchema = z.object({
  coverage: z.enum(['complete', 'partial']),
  edits: z.object({
    total: z.number().int().nonnegative(),
    files: z.array(z.string().max(160)).max(8),
  }).strict(),
  verification: z.object({
    total: z.number().int().nonnegative(),
    evidence: z.array(z.object({
      command: z.string().max(60),
      outcome: z.enum(['passed', 'failed', 'pending']),
    }).strict()).max(4),
  }).strict(),
  steps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolCallsByName: z.record(z.string().max(64), z.number().int().nonnegative())
    .refine(value => Object.keys(value).length <= 12),
  tokenUsage: tokenDeltaSchema,
}).strict()

export const recoveryCapsuleSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal('DURABLE_EVENT_FOLD'),
  modelCallsUsed: z.literal(0),
  maxBytes: z.literal(RECOVERY_CAPSULE_MAX_BYTES),
  byteLength: z.number().int().nonnegative().max(RECOVERY_CAPSULE_MAX_BYTES),
  parentRunId: z.string().uuid(),
  objective: z.string().max(1_024),
  objectiveTruncated: z.boolean(),
  interruption: z.object({
    kind: z.literal('HOST_RESTART_INTERRUPTED'),
    boundarySeq: z.number().int().min(-1),
    asOfSeq: z.number().int().min(-1),
  }).strict(),
  runTree: z.object({
    coverage: z.literal('complete'),
    totalSessions: z.number().int().positive().max(65),
    sessions: z.array(z.object({
      sessionId: z.string().min(1).max(512),
      activationSeq: z.number().int().min(-1),
      terminalSeq: z.number().int().min(-1),
    }).strict()).min(1).max(65),
  }).strict().superRefine((value, context) => {
    if (value.totalSessions !== value.sessions.length) {
      context.addIssue({ code: 'custom', path: ['totalSessions'], message: 'totalSessions must match sessions length' })
    }
    if (new Set(value.sessions.map(entry => entry.sessionId)).size !== value.sessions.length) {
      context.addIssue({ code: 'custom', path: ['sessions'], message: 'run-tree session ids must be unique' })
    }
  }),
  lastAcceptedProgress: z.object({
    phase: z.enum(['investigating', 'implementing', 'verifying', 'recovering']),
    milestone: z.string().max(512),
    nextAction: z.string().max(512),
    currentHypothesis: z.string().max(512).optional(),
    risk: z.string().max(256).optional(),
  }).strict().optional(),
  workspace: z.object({
    baseline: z.object({
      head: z.string().max(128).optional(),
      statusSummary: z.string().max(1_024),
      truncated: z.boolean(),
    }).strict().optional(),
    activity: recoveryActivitySchema,
  }).strict(),
  budget: z.object({
    limitTokens: z.number().int().positive(),
    observedTokens: z.number().int().nonnegative(),
    remainingTokens: z.number().int().nonnegative(),
    exhausted: z.boolean(),
  }).strict().optional(),
  uncertainEffects: uncertainEffectLedgerSchema,
  continuation: z.object({
    action: z.enum(['CONTINUE_FROM_DURABLE_EVIDENCE', 'RECONCILE_UNCERTAIN_EFFECTS_THEN_CONTINUE']),
    replayPolicy: z.literal('DO_NOT_BLINDLY_REPLAY'),
    evidenceOnly: z.literal(true),
  }).strict(),
}).strict().superRefine((value, context) => {
  const actualBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (actualBytes > RECOVERY_CAPSULE_MAX_BYTES) {
    context.addIssue({ code: 'custom', message: `recovery capsule exceeds ${String(RECOVERY_CAPSULE_MAX_BYTES)} bytes` })
  }
  if (actualBytes !== value.byteLength) {
    context.addIssue({ code: 'custom', path: ['byteLength'], message: `expected serialized byte length ${String(actualBytes)}` })
  }
})
export type RecoveryCapsule = z.infer<typeof recoveryCapsuleSchema>

export const observationSchema = z.object({
  schemaVersion: z.literal(1),
  hostInstanceId: z.string().max(512),
  taskId: z.string().max(512),
  objective: z.string().max(8_192),
  status: z.enum([
    'COMPLETED', 'BLOCKED', 'APPROVAL_REQUIRED', 'QUESTION_REQUIRED',
    'SUPERVISOR_REQUIRED', 'MAJOR_CHECKPOINT', 'FAILED', 'ESCALATION_REQUIRED', 'WAITING',
  ]),
  workerState: workerStateSchema,
  stage: z.string().max(HANDOFF_STAGE_LIMIT),
  summary: z.string().max(2_048),
  files: z.array(z.string().max(HANDOFF_PATH_LIMIT)).max(HANDOFF_FILES_LIMIT),
  verification: z.array(verificationSchema).max(HANDOFF_VERIFICATION_LIMIT),
  blocker: z.string().max(HANDOFF_BLOCKER_LIMIT).optional(),
  failure: z.object({
    kind: failureKindSchema,
    message: z.string().max(FAILURE_MESSAGE_LIMIT),
    retryable: z.boolean(),
    stale: z.boolean().optional(),
  }).optional(),
  wait: z.discriminatedUnion('reason', [
    z.object({ reason: z.literal('TIMEOUT'), timeoutMs: z.number().int().nonnegative() }),
    z.object({ reason: z.literal('PROGRESS') }),
  ]).optional(),
  approval: z.object({
    rpcId: z.string().max(INTERACTION_ID_LIMIT),
    approvalId: z.string().max(INTERACTION_ID_LIMIT),
    toolName: z.string().max(APPROVAL_TOOL_NAME_LIMIT),
    callId: z.string().max(INTERACTION_ID_LIMIT).optional(),
    reason: z.string().max(APPROVAL_REASON_LIMIT).optional(),
    truncated: z.literal(true).optional(),
    answerInWeb: z.literal(true).optional(),
  }).optional(),
  question: z.object({
    rpcId: z.string().max(INTERACTION_ID_LIMIT),
    questions: z.array(z.object({
      id: z.string().max(QUESTION_ID_LIMIT),
      question: z.string().max(QUESTION_TEXT_LIMIT),
      detail: z.string().max(QUESTION_DETAIL_LIMIT).optional(),
      header: z.string().max(QUESTION_HEADER_LIMIT).optional(),
      options: z.array(z.object({
        label: z.string().max(QUESTION_OPTION_LABEL_LIMIT),
        description: z.string().max(QUESTION_OPTION_DESCRIPTION_LIMIT).optional(),
      }).strict()).max(QUESTION_OPTIONS_LIMIT).optional(),
      multiSelect: z.boolean().optional(),
      intent: z.object({ kind: z.literal('plan-review'), approve: z.string().max(QUESTION_OPTION_LABEL_LIMIT) }).strict().optional(),
    }).strict()).max(QUESTION_COUNT_LIMIT),
    truncated: z.literal(true).optional(),
    answerInWeb: z.literal(true).optional(),
  }).strict().optional(),
  failureSignature: z.string().max(HANDOFF_FAILURE_SIGNATURE_LIMIT).optional(),
  attemptedHypotheses: z.array(z.string().max(HANDOFF_HYPOTHESIS_LIMIT)).max(HANDOFF_HYPOTHESES_LIMIT).optional(),
  artifacts: z.array(artifactSchema).max(HANDOFF_ARTIFACTS_LIMIT),
  handoffTruncated: z.object({
    fields: z.array(z.enum([
      'stage', 'summary', 'files', 'verification', 'blocker', 'failureSignature', 'attemptedHypotheses', 'artifacts',
    ])).max(8),
  }).strict().optional(),
  telemetry: z.object({
    asOfSeq: z.number().int().min(-1),
    tokenUsage: telemetryTokenUsageSchema.optional(),
    sessionStats: telemetrySessionStatsSchema.optional(),
    subagent: telemetrySubagentSchema.optional(),
  }).optional(),
  budget: z.object({
    limitTokens: z.number().int().positive(),
    observedTokens: z.number().int().nonnegative(),
    remainingTokens: z.number().int().nonnegative(),
    exhausted: z.boolean(),
    coverage: z.enum(['root_session', 'run_tree']),
    enforcement: z.literal('DSH_HOST_RUNTIME'),
    overshootBound: z.literal('IN_FLIGHT_MODEL_RESPONSES'),
    sessions: z.number().int().nonnegative().optional(),
    uncachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  usageMonitor: z.object({
    source: z.literal('dsh-usage-monitor'),
    authoritativeForBudget: z.literal(false),
    available: z.boolean(),
    found: z.boolean(),
    scope: z.literal('session_lifetime'),
    includesDescendants: z.literal(false),
    sessionRawTokens: z.number().int().nonnegative().optional(),
    requestCount: z.number().int().nonnegative().optional(),
    warning: z.string().max(256).optional(),
  }).strict().optional(),
  recovery: z.object({
    kind: z.enum(['REATTACHED', 'CONTINUATION_REQUIRED']),
    reason: z.string().max(256),
    parentRunId: z.string().uuid().optional(),
  }).strict().optional(),
  recoveryCapsule: recoveryCapsuleSchema.optional(),
  projectActivity: projectActivitySchema.optional(),
  progress: progressHeartbeatSchema.optional(),
  supervisorProgress: supervisorProgressSchema.optional(),
  decision: decisionOutcomeSchema.optional(),
  decisionShadow: decisionOutcomeSchema.extend({ differs: z.boolean() }).optional(),
  journal: z.object({
    recorded: z.boolean(),
    recordId: z.string().max(512),
    created: z.boolean().optional(),
    warning: z.string().max(512).optional(),
  }).strict().optional(),
  asOfSeq: z.number().int().min(-1),
  boundarySeq: z.number().int().min(-1),
  sessionId: z.string().max(512),
  runId: z.string().max(512),
})
export type Observation = z.infer<typeof observationSchema>

const packetTextSchema = z.string().max(32_768)
const packetListSchema = z.array(z.string().max(4_096)).max(64)

export const taskPacketV1Schema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1).max(512),
  completionToken: z.string().min(1).max(512),
  objective: z.string().min(1).max(8_192),
  writerMode: z.enum(['writer', 'read_only']),
  context: packetTextSchema.optional(),
  allowedScope: packetListSchema.optional(),
  constraints: packetListSchema.optional(),
  acceptanceCriteria: packetListSchema.optional(),
  verification: packetListSchema.optional(),
  escalationConditions: packetListSchema.optional(),
}).strict()

export const taskPacketV2Schema = z.object({
  schemaVersion: z.literal(2),
  sessionId: z.string().min(1).max(512),
  runId: z.string().uuid(),
  completionToken: z.string().uuid(),
  objective: z.string().min(1).max(8_192),
  writerMode: z.enum(['writer', 'read_only']),
  requestId: z.string().uuid().optional(),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  budget: z.object({
    /** Provider-reported uncached input + cache read/write + output across the run tree. */
    maxTokens: z.number().int().positive(),
  }).strict().optional(),
  parentRunId: z.string().uuid().optional(),
  recoveryCapsule: recoveryCapsuleSchema.optional(),
  baseline: z.object({
    head: z.string().max(256).optional(),
    statusSummary: z.string().max(4_096),
  }).strict().optional(),
  context: packetTextSchema.optional(),
  allowedScope: packetListSchema.optional(),
  constraints: packetListSchema.optional(),
  acceptanceCriteria: packetListSchema.optional(),
  verification: packetListSchema.optional(),
  escalationConditions: packetListSchema.optional(),
  authority: z.object({
    maxDirectChildren: z.number().int().min(0).max(64).optional(),
    preAuthorizedActions: packetListSchema.optional(),
    preAuthorizedDecisionCategories: z.array(z.enum(DECISION_CATEGORIES)).max(10).optional(),
  }).strict().optional(),
  decisionPolicy: z.object({
    activeVersion: z.string().min(1).max(128),
    activeDigest: z.string().regex(/^[0-9a-f]{64}$/),
    shadowVersion: z.string().min(1).max(128).optional(),
    shadowDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }).strict().optional(),
  /** Migration-only alias for workers that still read the v1 taskId field. */
  taskId: z.string().min(1).max(512).optional(),
}).strict().superRefine((value, context) => {
  if (value.parentRunId !== undefined && value.recoveryCapsule === undefined) {
    context.addIssue({ code: 'custom', path: ['recoveryCapsule'], message: 'parentRunId requires recoveryCapsule' })
  } else if (value.recoveryCapsule !== undefined && value.parentRunId === undefined) {
    context.addIssue({ code: 'custom', path: ['parentRunId'], message: 'recoveryCapsule requires parentRunId' })
  } else if (value.recoveryCapsule !== undefined && value.recoveryCapsule.parentRunId !== value.parentRunId) {
    context.addIssue({ code: 'custom', path: ['recoveryCapsule', 'parentRunId'], message: 'recoveryCapsule parentRunId must match task parentRunId' })
  }
})

export const taskPacketSchema = z.discriminatedUnion('schemaVersion', [taskPacketV1Schema, taskPacketV2Schema])
export type TaskPacketV1 = z.infer<typeof taskPacketV1Schema>
export type TaskPacketV2 = z.infer<typeof taskPacketV2Schema>
export type TaskPacket = z.infer<typeof taskPacketSchema>

export interface PendingApproval {
  rpcId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
  truncated?: true
  answerInWeb?: true
}

export interface PendingQuestion {
  rpcId: string
  questions: Array<{
    id: string
    question: string
    detail?: string
    header?: string
    options?: Array<{ label: string; description?: string }>
    multiSelect?: boolean
    intent?: { kind: 'plan-review'; approve: string }
  }>
  truncated?: true
  answerInWeb?: true
}

export interface TaskRuntimeState {
  hostInstanceId: string
  /** Authoritative session cwd, used only to make project-activity paths relative and contained. */
  cwd?: string
  events: readonly DshEvent[]
  workerState: WorkerState
  pendingApproval?: PendingApproval
  pendingQuestion?: PendingQuestion
  hostError?: string
  telemetry?: {
    asOfSeq: number
    tokenUsage?: z.infer<typeof telemetryTokenUsageSchema>
    sessionStats?: z.infer<typeof telemetrySessionStatsSchema>
    subagent?: z.infer<typeof telemetrySubagentSchema>
  }
}

export interface DshEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

export const TASK_PACKET_START = '<dsh-supervised-task>'
export const TASK_PACKET_END = '</dsh-supervised-task>'
