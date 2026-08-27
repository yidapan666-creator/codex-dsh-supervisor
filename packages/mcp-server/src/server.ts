import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { observationSchema } from './contracts.js'
import { GatewayManager } from './gateway.js'
import { DECISION_CATEGORIES } from '@dsh-gate/decision-policy'

type JsonRecord = Record<string, unknown>

function result(value: JsonRecord): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

/** Keep tool failures machine-readable so Host outages are not flattened into session lookup errors. */
export function toolFailureEnvelope(error: unknown): JsonRecord {
  const message = error instanceof Error ? error.message : String(error)
  const lookupFailure = /session .*\b(?:not found|does not exist|no longer present)\b/i.test(message)
  const hostFailure = !lookupFailure && /DSH Host|configured Host|connecting to|connect to any/i.test(message)
  return {
    schemaVersion: 1,
    status: 'FAILED',
    failure: {
      kind: hostFailure ? 'HOST_FAILED' : 'PROTOCOL_ERROR',
      message,
      retryable: hostFailure,
    },
  }
}

function guarded<T extends JsonRecord>(handler: (input: T) => Promise<JsonRecord | z.infer<typeof observationSchema>>) {
  return async (input: T): Promise<CallToolResult> => {
    try { return result(await handler(input)) } catch (error) {
      const envelope = toolFailureEnvelope(error)
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      }
    }
  }
}

export function createServer(manager = GatewayManager.fromEnvironment()): McpServer {
  const server = new McpServer({ name: 'dsh-gate', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions: 'Supervise DSH root sessions through these lifecycle tools. Accept COMPLETED only when dsh_wait '
      + 'returns it: the runtime requires a valid matching supervisor_handoff result, that turn ending, and every affiliated child settling. '
      + 'Carry asOfSeq into afterAsOfSeq only as an observation cursor; DSH since is not a resume cursor. '
      + 'dsh_wait runs the five-minute aggregated cadence: one observation about every 300000 ms, returning early only '
      + 'when the explainable decision outcome says immediate. Protocol boundaries are locked; structured worker requests are policy-evaluated. Follow decision.action and decision.audience instead of treating needsSupervisor as authority. A WAITING/TIMEOUT return carries aggregated '
      + 'progress — step/tool/token deltas plus compact project edit/verification activity — since the prior observation; do not '
      + 're-poll on ordinary event churn. Surface activity coverage and runtime verification evidence separately from worker claims, and recap steps, tools, token deltas, project activity, '
      + 'and verification results at terminal state. '
      + 'Terminal observations also report whether the model-free run journal was recorded; journal warnings never change the task outcome. '
      + 'Treat decisionShadow as observer-only comparison data; only decision controls the current run. '
      + 'Treat sessionId and runId as distinct: every wait or control call must carry the runId returned by dsh_task; stale controls are rejected. '
      + 'Always give dsh_task a fresh requestId and reuse that same requestId after an ambiguous client disconnect; Host-side atomic admission returns the durable receipt and does not duplicate the task. '
      + 'A configured tokenBudget is enforced inside the independent DSH Host across the run tree with request preflight, atomic reservations, and output caps; provider usage settles the estimate, so it is a cutoff rather than an exact billing cap. The external dsh-usage-monitor reading is optional observability and never budget authority. '
      + 'After MCP/Codex reconnect, use dsh_runs to rediscover identity and dsh_recover to reattach before waiting. Do not replay the objective. '
      + 'DSH root exclusively manages its children: child reports and settled notices are delivered to root automatically. Never steer root to relay, acknowledge, '
      + 'or take over completed child work. A root handoff remains WAITING while affiliated children run; their durable budget stop overrides the older root handoff. dsh_agents is observation-only; interrupt a child only on an explicit human request or a clear safety emergency. '
      + 'Never stop the independently owned DSH Host. '
      + 'Use one writer per real working tree; parallel writers require independent worktrees.',
  })

  server.registerTool('dsh_start_or_connect', {
    description: 'Connect to an independently owned DSH Host and create or reconnect a session. MCP shutdown never stops the Host.',
    inputSchema: z.object({
      hostBaseUrl: z.string().url().optional(), cwd: z.string().optional(), sessionId: z.string().optional(), agentPreset: z.string().optional(),
    }),
  }, guarded(input => manager.startOrConnect(input)))

  server.registerTool('dsh_task', {
    description: 'Atomically admit one supervised run into an idle durable session. Supply a fresh UUID requestId and reuse it after any ambiguous disconnect: the Host commits a durable inbox receipt and returns the original runId without duplicating the task. A different new task is rejected while the session is running. Optional tokenBudget.maxTokens is a Host-enforced whole-run-tree cutoff: requests atomically reserve estimated full input plus capped output before dispatch, then settle with provider-reported input/cache/output usage. Concurrent requests cannot claim the same allowance; tokenizer/provider variance means this is not an exact billing cap. authority.maxDirectChildren is also enforced in the Host from durable child creations and in-flight start reservations, so allowed child use needs no repeat approval. Every later wait/control call must carry sessionId + runId. One writer per working tree is enforced; use an independent worktree for parallel writers.',
    inputSchema: z.object({
      requestId: z.string().uuid().optional(),
      sessionId: z.string(), taskId: z.string().optional(), objective: z.string().min(1), writerMode: z.enum(['writer', 'read_only']).optional(),
      provider: z.string().optional(), model: z.string().optional(), reasoningEffort: z.string().optional(),
      context: z.string().optional(), allowedScope: z.array(z.string()).optional(), constraints: z.array(z.string()).optional(),
      acceptanceCriteria: z.array(z.string()).optional(), verification: z.array(z.string()).optional(),
      escalationConditions: z.array(z.string()).optional(),
      tokenBudget: z.object({ maxTokens: z.number().int().positive() }).optional(),
      parentRunId: z.string().uuid().optional(),
      baseline: z.object({ head: z.string().optional(), statusSummary: z.string() }).optional(),
      authority: z.object({
        maxDirectChildren: z.number().int().min(0).max(64).optional(),
        preAuthorizedActions: z.array(z.string()).optional(),
        preAuthorizedDecisionCategories: z.array(z.enum(DECISION_CATEGORIES)).optional(),
      }).optional(),
    }),
  }, guarded(input => manager.task(input)))

  server.registerTool('dsh_runs', {
    description: 'Rediscover durable supervised run identities from configured DSH Hosts after MCP/Codex context loss. This is read-only and never replays a task.',
    inputSchema: z.object({}),
  }, guarded(() => manager.runs()))

  server.registerTool('dsh_recover', {
    description: 'Reattach to one existing durable run after MCP/Codex reconnect without replaying its objective. If a Host crash interrupted the in-flight turn, returns CONTINUATION_REQUIRED; start a new bounded dsh_task with parentRunId instead of guessing success.',
    inputSchema: z.object({ sessionId: z.string(), taskId: z.string().optional(), runId: z.string().uuid().optional() }),
    outputSchema: observationSchema,
  }, guarded(input => manager.recover(input)))

  server.registerTool('dsh_wait', {
    description: 'Wait the five-minute aggregated progress cadence (default 300000 ms). Returns early when the attached explainable decision says timing=immediate; protocol boundaries are locked and structured worker requests are policy-evaluated. Follow decision.action/audience/reasonCode. A WAITING/TIMEOUT return is the cadence observation: aggregate progress since afterAsOfSeq, including step/tool/token deltas, compact project edit/verification activity, and the latest accepted bounded semantic milestone. Surface the summary to the user; terminal reports must recap steps, tools, token deltas, and project activity. afterAsOfSeq is only an observation cursor, never DSH since.',
    inputSchema: z.object({
      sessionId: z.string(), runId: z.string().uuid(), taskId: z.string().optional(),
      afterAsOfSeq: z.number().int().min(-1).optional(), timeoutMs: z.number().int().min(0).max(300_000).optional(),
    }),
    outputSchema: observationSchema,
  }, guarded(input => manager.wait(input)))

  server.registerTool('dsh_steer', {
    description: 'Send explicit user-authored new guidance to the active DSH root. Never use this to relay child completion/results, acknowledge settled children, wake root to take over child work, or synthesize supervisor nudges; DSH Host delivers child reports to root automatically.',
    inputSchema: z.object({ sessionId: z.string(), runId: z.string().uuid(), taskId: z.string().optional(), message: z.string().min(1) }),
  }, guarded(input => manager.steer(input)))

  server.registerTool('dsh_answer_question', {
    description: 'Answer the current DSH user-question batch as one response. rpcId must match the current pending interaction; stale replies are rejected.',
    inputSchema: z.object({
      sessionId: z.string(), runId: z.string().uuid(), taskId: z.string().optional(), rpcId: z.string(),
      answers: z.array(z.object({ id: z.string(), selected: z.array(z.string()), custom: z.string().optional() })),
    }),
  }, guarded(input => manager.answerQuestion(input)))

  server.registerTool('dsh_answer_approval', {
    description: 'Resolve the current DSH approval request. rpcId must match the current pending interaction; stale replies are rejected.',
    inputSchema: z.object({
      sessionId: z.string(), runId: z.string().uuid(), taskId: z.string().optional(), rpcId: z.string(),
      outcome: z.enum(['allowed-once', 'rejected']),
    }),
  }, guarded(input => manager.answerApproval(input)))

  server.registerTool('dsh_cancel', {
    description: 'Cancel the active DSH root turn without stopping the Host.',
    inputSchema: z.object({ sessionId: z.string(), runId: z.string().uuid(), taskId: z.string().optional() }),
  }, guarded(input => manager.cancel(input)))

  server.registerTool('dsh_agents', {
    description: 'Read-only direct-child observability with per-child telemetry. DSH root remains the manager and automatically receives child reports; listing a settled child never authorizes steering root.',
    inputSchema: z.object({ sessionId: z.string(), runId: z.string().uuid(), taskId: z.string().optional() }),
  }, guarded(input => manager.agents(input)))

  server.registerTool('dsh_interrupt_agent', {
    description: 'Emergency interrupt for one continuable direct child. Use only on explicit human request or a clear safety/resource emergency, never for routine completion or orchestration; DSH root owns child control.',
    inputSchema: z.object({
      sessionId: z.string(), runId: z.string().uuid(), taskId: z.string().optional(), childSessionId: z.string(),
    }),
  }, guarded(input => manager.interruptAgent(input)))

  server.server.onclose = () => { manager.stopClients() }

  return server
}
