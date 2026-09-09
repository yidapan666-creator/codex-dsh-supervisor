import { z } from 'zod'

export const executionControlInputSchema = z.object({
  sessionId: z.string().min(1).max(512), runId: z.string().uuid(),
  action: z.enum(['status', 'grant', 'renew', 'pause', 'revise', 'record_review']),
  verdict: z.enum(['ACCEPTED', 'REJECTED']).optional(),
  asOfSeq: z.number().int().nonnegative().optional(),
  evidence: z.string().min(1).max(1024).optional(),
  expectedGeneration: z.number().int().nonnegative().optional(),
  phase: z.string().min(1).max(256).optional(),
  paths: z.array(z.string().min(1).max(4096)).max(64).optional(),
  opaqueTools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(16).optional(),
  acknowledgeUnconfinedEffects: z.boolean().optional(),
  leaseMs: z.number().int().min(1000).max(600_000).optional(),
  maxEffects: z.number().int().min(1).max(64).optional(),
}).strict()
export const executionStateSchema = z.object({
  independentReview: z.object({ verdict: z.enum(['ACCEPTED', 'REJECTED']), asOfSeq: z.number().int().nonnegative(), evidence: z.string().min(1).max(1024), recordedAt: z.number().int().nonnegative(), source: z.literal('SUPERVISOR_DECLARATION') }).strict().optional(),
  contract: z.literal('execution-lease-v1'), sessionId: z.string(), runId: z.string().uuid(),
  generation: z.number().int().nonnegative(), mode: z.enum(['investigating', 'granted', 'paused']),
  bootId: z.string(), phase: z.string().max(256), expiresAt: z.number().int().nonnegative(),
  remainingEffects: z.number().int().min(0).max(64), paths: z.array(z.string()).max(64), opaqueTools: z.array(z.string()).max(16), reason: z.string().max(1024),
  status: z.enum(['INVESTIGATING', 'GRANTED', 'PAUSED', 'EXPIRED', 'RESTARTED', 'AWAITING_GRANT']),
  waitingEffects: z.number().int().nonnegative(), activeEffects: z.number().int().nonnegative(),
  quiescence: z.enum(['NO_TRACKED_EFFECTS', 'EFFECTS_IN_FLIGHT']), externalEffectConfinement: z.literal('NOT_PROVIDED'),
}).strict()
export type ExecutionControlInput = z.infer<typeof executionControlInputSchema>
export type ExecutionState = z.infer<typeof executionStateSchema>

export async function postExecutionControl(baseUrl: string, command: ExecutionControlInput, token?: string): Promise<ExecutionState> {
  const response = await fetch(new URL('/api/dsh-gate.execution-control', baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json', ...token === undefined ? {} : { authorization: `Bearer ${token}` } },
    body: JSON.stringify(executionControlInputSchema.parse(command)), signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error('Host execution control unavailable/rejected. Read current status and reconsider; never replay a grant or task blindly.')
  const state = executionStateSchema.parse(await response.json())
  if (state.sessionId !== command.sessionId || state.runId !== command.runId) throw new Error('Execution control identity mismatch')
  return state
}
