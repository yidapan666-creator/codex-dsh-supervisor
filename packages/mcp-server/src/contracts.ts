import { z } from 'zod'

export const failureKindSchema = z.enum([
  'WORKER_FAILED', 'HOST_FAILED', 'MISSING_HANDOFF', 'PROTOCOL_ERROR',
])
export type FailureKind = z.infer<typeof failureKindSchema>

export const workerStateSchema = z.enum(['RUNNING', 'IDLE', 'UNKNOWN'])
export type WorkerState = z.infer<typeof workerStateSchema>

export const verificationSchema = z.object({
  command: z.string(),
  outcome: z.enum(['passed', 'failed', 'not_run']),
  summary: z.string(),
})

export const artifactSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

const tokenDeltaSchema = z.object({
  uncachedInputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
})

/** Bounded summary of edit/write and targeted verification activity since the prior observation. */
export const editWriteActivitySchema = z.object({
  /** Complete only when every observed tool is classifiable for project mutation coverage. */
  coverage: z.enum(['complete', 'partial']),
  edits: z.object({
    /** Distinct project files touched by successful mutating tool calls. */
    total: z.number().int().nonnegative(),
    /** Bounded sample of those file paths, project-focused and sanitized. */
    files: z.array(z.string()),
  }),
  verification: z.object({
    /** Distinct targeted verification commands attempted (for example `pnpm verify`). */
    total: z.number().int().nonnegative(),
    /** Bounded sample of compact command labels. */
    commands: z.array(z.string()),
    /** Runtime-correlated tool outcomes, distinct from worker handoff claims. */
    evidence: z.array(z.object({
      command: z.string(),
      outcome: z.enum(['passed', 'failed', 'pending']),
    })),
  }),
})
export type EditWriteActivity = z.infer<typeof editWriteActivitySchema>

/** Task-scope project activity attached to terminal observations. */
export const projectActivitySchema = editWriteActivitySchema.extend({
  steps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolCallsByName: z.record(z.string(), z.number().int().nonnegative()),
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
    deltaByName: z.record(z.string(), z.number().int().nonnegative()),
  }),
  tokenDelta: tokenDeltaSchema,
  lastActivity: z.object({
    seq: z.number().int().min(-1),
    time: z.number(),
    kind: z.enum(['turn', 'step', 'model_stream', 'model_message', 'tool_call', 'tool_result']),
    step: z.number().int().nonnegative().optional(),
    toolName: z.string().optional(),
  }).optional(),
  projectActivity: editWriteActivitySchema,
})
export type ProgressHeartbeat = z.infer<typeof progressHeartbeatSchema>

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
}).strict()
export type SupervisorProgress = z.infer<typeof supervisorProgressSchema>

export const observationSchema = z.object({
  schemaVersion: z.literal(1),
  hostInstanceId: z.string(),
  taskId: z.string(),
  objective: z.string(),
  status: z.enum([
    'COMPLETED', 'BLOCKED', 'APPROVAL_REQUIRED', 'QUESTION_REQUIRED',
    'SUPERVISOR_REQUIRED', 'MAJOR_CHECKPOINT', 'FAILED', 'ESCALATION_REQUIRED', 'WAITING',
  ]),
  workerState: workerStateSchema,
  stage: z.string(),
  summary: z.string().max(2_048),
  files: z.array(z.string()),
  verification: z.array(verificationSchema),
  blocker: z.string().optional(),
  failure: z.object({
    kind: failureKindSchema,
    message: z.string(),
    retryable: z.boolean(),
    stale: z.boolean().optional(),
  }).optional(),
  wait: z.discriminatedUnion('reason', [
    z.object({ reason: z.literal('TIMEOUT'), timeoutMs: z.number().int().nonnegative() }),
    z.object({ reason: z.literal('PROGRESS') }),
  ]).optional(),
  approval: z.object({
    rpcId: z.string(), approvalId: z.string(), toolName: z.string(), callId: z.string().optional(), reason: z.string().optional(),
  }).optional(),
  question: z.object({ rpcId: z.string(), questions: z.array(z.unknown()) }).optional(),
  failureSignature: z.string().optional(),
  attemptedHypotheses: z.array(z.string()).optional(),
  artifacts: z.array(artifactSchema),
  telemetry: z.object({
    asOfSeq: z.number().int().min(-1),
    tokenUsage: z.unknown().optional(),
    sessionStats: z.unknown().optional(),
    subagent: z.unknown().optional(),
  }).optional(),
  projectActivity: projectActivitySchema.optional(),
  progress: progressHeartbeatSchema.optional(),
  supervisorProgress: supervisorProgressSchema.optional(),
  asOfSeq: z.number().int().min(-1),
  boundarySeq: z.number().int().min(-1),
  sessionId: z.string(),
  runId: z.string(),
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
  parentRunId: z.string().uuid().optional(),
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
  }).strict().optional(),
  /** Migration-only alias for workers that still read the v1 taskId field. */
  taskId: z.string().min(1).max(512).optional(),
}).strict()

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
}

export interface PendingQuestion {
  rpcId: string
  questions: unknown[]
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
    tokenUsage?: unknown
    sessionStats?: unknown
    subagent?: unknown
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
