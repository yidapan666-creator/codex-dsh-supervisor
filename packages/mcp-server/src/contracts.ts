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
})
export type ProgressHeartbeat = z.infer<typeof progressHeartbeatSchema>

export const observationSchema = z.object({
  schemaVersion: z.literal(1),
  hostInstanceId: z.string(),
  taskId: z.string(),
  objective: z.string(),
  status: z.enum([
    'COMPLETED', 'BLOCKED', 'APPROVAL_REQUIRED', 'QUESTION_REQUIRED',
    'MAJOR_CHECKPOINT', 'FAILED', 'ESCALATION_REQUIRED', 'WAITING',
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
  progress: progressHeartbeatSchema.optional(),
  asOfSeq: z.number().int().min(-1),
  boundarySeq: z.number().int().min(-1),
})
export type Observation = z.infer<typeof observationSchema>

export interface TaskPacket {
  schemaVersion: 1
  taskId: string
  completionToken: string
  objective: string
  writerMode: 'writer' | 'read_only'
  context?: string
  allowedScope?: string[]
  constraints?: string[]
  acceptanceCriteria?: string[]
  verification?: string[]
  escalationConditions?: string[]
}

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
