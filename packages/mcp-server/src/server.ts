import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  FAILURE_MESSAGE_LIMIT, INTERACTION_ID_LIMIT, QUESTION_COUNT_LIMIT, QUESTION_ID_LIMIT,
  QUESTION_OPTION_LABEL_LIMIT,
  observationSchema, recoveryCapsuleSchema,
} from './contracts.js'
import { GatewayManager, HostDiscoveryError } from './gateway.js'
import { ProtocolContractError } from './host.js'
import { DECISION_CATEGORIES } from '@dsh-gate/decision-policy'

type JsonRecord = Record<string, unknown>

function result(value: JsonRecord): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

/** Keep tool failures machine-readable so Host outages are not flattened into session lookup errors. */
export function toolFailureEnvelope(error: unknown): JsonRecord {
  const fullMessage = error instanceof Error ? error.message : String(error)
  const message = fullMessage.slice(0, FAILURE_MESSAGE_LIMIT)
  const discoveryFailure = error instanceof HostDiscoveryError
  const protocolContractFailure = error instanceof ProtocolContractError
  const lookupFailure = /session .*\b(?:not found|does not exist|no longer present)\b/i.test(fullMessage)
  const hostFailure = !protocolContractFailure
    && (discoveryFailure || (!lookupFailure && /DSH Host|configured Host|connecting to|connect to any/i.test(fullMessage)))
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
      + 'returns it: the runtime requires a valid matching Root supervisor_handoff result, that turn ending, and every affiliated child settling. If a child settles after an earlier Root handoff, Root must integrate it and publish a strictly newer valid handoff plus turn end. '
      + 'Carry asOfSeq into afterAsOfSeq only as an observation cursor; DSH since is not a resume cursor. '
      + 'dsh_wait runs the five-minute aggregated cadence: one observation about every 300000 ms, returning early only '
      + 'when the explainable decision outcome says immediate. Protocol boundaries are locked; structured worker requests are policy-evaluated. Follow decision.action and decision.audience instead of treating needsSupervisor as authority. A WAITING/TIMEOUT return carries aggregated '
      + 'progress — step/tool/token deltas plus compact project edit/verification activity — since the prior observation; do not '
      + 're-poll on ordinary event churn. Surface activity coverage and runtime verification evidence separately from worker claims, and recap steps, tools, token deltas, project activity, '
      + 'and verification results at terminal state. '
      + 'Terminal observations also report whether the model-free run journal was recorded; journal warnings never change the task outcome. '
      + 'If handoffTruncated is present, disclose which legacy or malformed handoff fields were defensively bounded; complete detail belongs in an admitted artifact. '
      + 'Treat decisionShadow as observer-only comparison data; only decision controls the current run. '
      + 'Treat sessionId and runId as distinct: every wait or control call must carry the runId returned by dsh_task; stale controls are rejected. '
      + 'When creating a session, pass the target project absolute cwd; reconnect preserves the durable session cwd and must not redirect it. '
      + 'Always give dsh_task a fresh requestId and reuse that same requestId after an ambiguous client disconnect; Host-side atomic admission returns the durable receipt and does not duplicate the task. '
      + 'A configured tokenBudget is enforced inside the independent DSH Host across the run tree with request preflight, atomic reservations, and output caps; provider usage settles the estimate, so it is a cutoff rather than an exact billing cap. Budgeted observations include the Host-owned cumulative run-tree buckets; cursor tokenDelta remains the root-session delta. The external dsh-usage-monitor reading is session-lifetime root observability only and never budget authority. '
      + 'After MCP/Codex reconnect, use dsh_runs to rediscover identity and dsh_recover to reattach before waiting. Do not replay the objective. '
      + 'When recovery returns CONTINUATION_REQUIRED, pass its exact full-run-tree recoveryCapsule and parentRunId into a fresh dsh_task; either field without the other is rejected, and admission recomputes the capsule from refreshed Host evidence before accepting it. Reconcile session-scoped uncertainEffects before retry and never reconstruct omitted arguments. '
      + 'DSH root exclusively manages its children: child reports and settled notices are delivered to root automatically. Never steer root to relay, acknowledge, '
      + 'or take over completed child work. A Root handoff remains WAITING while affiliated children run and becomes root-rehandoff-required when they settle after it; their durable budget stop overrides the older Root handoff. dsh_agents is observation-only and lists only children affiliated with the addressed run; interrupt a child only on an explicit human request or a clear safety emergency. '
      + 'Never stop the independently owned DSH Host. '
      + 'Use one writer per real working tree; the Host admits writers atomically across MCP clients, multi-Host writer topology fails closed, and parallel writers require independent worktrees.',
  })

  server.registerTool('dsh_start_or_connect', {
    description: 'Connect to an independently owned DSH Host and create or reconnect a session. Creating requires the target project absolute cwd and fixes one supervision-compatible DSH agent preset for the durable session: standard (default) or code (PTC). Reconnecting preserves both cwd and preset and rejects a conflicting requested value. Minimal cannot guarantee the strict read-only boundary; Creator has Host-runtime authoring authority, so neither is admitted for supervised project work. MCP shutdown never stops the Host.',
    inputSchema: z.object({
      hostBaseUrl: z.string().url().max(2_048).optional(), cwd: z.string().max(4_096).optional(),
      sessionId: z.string().max(512).optional(),
      agentPreset: z.string().max(256).optional()
        .describe('Durable DSH session preset. Supported: standard or code (the UI\'s PTC mode); omitted defaults to standard.'),
    }),
  }, guarded(input => manager.startOrConnect(input)))

  server.registerTool('dsh_task', {
    description: 'Atomically admit one supervised run into an idle durable session. Supply a fresh UUID requestId and reuse it after any ambiguous disconnect: the Host commits a durable inbox receipt and returns the original runId without duplicating the task. A different new task is rejected while the session is running. A Host-restart continuation must supply both the exact full-run-tree recoveryCapsule returned by dsh_recover and its matching parentRunId. Admission refreshes Host history, proves the parent is the current interrupted run for the same session, recomputes the capsule, and rejects missing, fabricated, stale, cross-session, or child-incomplete evidence before a provider call. Optional tokenBudget.maxTokens is a Host-enforced whole-run-tree cutoff: requests atomically reserve estimated full input plus capped output before dispatch, then settle with provider-reported input/cache/output usage. Concurrent requests cannot claim the same allowance; tokenizer/provider variance means this is not an exact billing cap. authority.maxDirectChildren is also enforced in the Host from durable child creations and in-flight start reservations, so allowed child use needs no repeat approval. Every later wait/control call must carry sessionId + runId. The Host atomically enforces one writer per working tree across MCP clients; writer dispatch fails closed under multi-Host configuration, and parallel writers require independent worktrees.',
    inputSchema: z.object({
      requestId: z.string().uuid().optional(),
      sessionId: z.string().max(512), taskId: z.string().max(512).optional(), objective: z.string().min(1).max(8_192), writerMode: z.enum(['writer', 'read_only']).optional(),
      provider: z.string().max(256).optional(), model: z.string().max(256).optional(), reasoningEffort: z.string().max(128).optional(),
      context: z.string().max(32_768).optional(), allowedScope: z.array(z.string().max(4_096)).max(64).optional(), constraints: z.array(z.string().max(4_096)).max(64).optional(),
      acceptanceCriteria: z.array(z.string().max(4_096)).max(64).optional(), verification: z.array(z.string().max(4_096)).max(64).optional(),
      escalationConditions: z.array(z.string().max(4_096)).max(64).optional(),
      tokenBudget: z.object({ maxTokens: z.number().int().positive() }).optional(),
      parentRunId: z.string().uuid().optional(),
      recoveryCapsule: recoveryCapsuleSchema.optional(),
      baseline: z.object({ head: z.string().max(512).optional(), statusSummary: z.string().max(32_768) }).optional(),
      authority: z.object({
        maxDirectChildren: z.number().int().min(0).max(64).optional(),
        preAuthorizedActions: z.array(z.string().max(4_096)).max(64).optional(),
        preAuthorizedDecisionCategories: z.array(z.enum(DECISION_CATEGORIES)).optional(),
      }).optional(),
    }),
  }, guarded(input => manager.task(input)))

  server.registerTool('dsh_runs', {
    description: 'Rediscover durable supervised run identities from configured DSH Hosts after MCP/Codex context loss. This is read-only, never replays a task, and applies the same strict child convergence/root-rehandoff completion validation as dsh_wait. A temporary budget projection failure is returned as budgetWarning without hiding the run identity.',
    inputSchema: z.object({}),
  }, guarded(() => manager.runs()))

  server.registerTool('dsh_recover', {
    description: 'Reattach to one existing durable run by exact sessionId + runId after MCP/Codex reconnect without replaying its objective. A stale run fails without claiming REATTACHED. If a Host crash interrupted the in-flight turn, reconstructs the complete affiliated run tree and returns CONTINUATION_REQUIRED plus a <=16 KiB recoveryCapsule derived without a model call. Recovery fails closed without a capsule if child history cannot be reconciled. Start a new bounded dsh_task with parentRunId and that exact capsule; reconcile its session-scoped uncertainEffects before retrying any unresolved tool call.',
    inputSchema: z.object({ sessionId: z.string().max(512), taskId: z.string().max(512).optional(), runId: z.string().uuid() }),
    outputSchema: observationSchema,
  }, guarded(input => manager.recover(input)))

  server.registerTool('dsh_wait', {
    description: 'Wait the five-minute aggregated progress cadence (default 300000 ms). Returns early when the attached explainable decision says timing=immediate; protocol boundaries are locked and structured worker requests are policy-evaluated. Follow decision.action/audience/reasonCode. A WAITING/TIMEOUT return is the cadence observation: aggregate root-session progress since afterAsOfSeq, including step/tool/token deltas, compact project edit/verification activity, and the latest accepted bounded semantic milestone. Budgeted observations additionally report cumulative Host-owned run-tree token buckets and counted sessions. Surface the summary to the user; terminal reports must recap steps, tools, token deltas, and project activity. afterAsOfSeq is only an observation cursor, never DSH since.',
    inputSchema: z.object({
      sessionId: z.string().max(512), runId: z.string().uuid(), taskId: z.string().max(512).optional(),
      afterAsOfSeq: z.number().int().min(-1).optional(), timeoutMs: z.number().int().min(0).max(300_000).optional(),
    }),
    outputSchema: observationSchema,
  }, guarded(input => manager.wait(input)))

  server.registerTool('dsh_steer', {
    description: 'Send explicit user-authored new guidance to the active DSH root. Never use this to relay child completion/results, acknowledge settled children, wake root to take over child work, or synthesize supervisor nudges; DSH Host delivers child reports to root automatically.',
    inputSchema: z.object({ sessionId: z.string().max(512), runId: z.string().uuid(), taskId: z.string().max(512).optional(), message: z.string().min(1).max(8_192) }),
  }, guarded(input => manager.steer(input)))

  server.registerTool('dsh_answer_question', {
    description: 'Answer the current bounded DSH user-question batch as one response. rpcId must match the current pending interaction; stale replies are rejected. When the observation says answerInWeb=true, use DSH Web for the full oversized batch instead of answering its truncated preview here.',
    inputSchema: z.object({
      sessionId: z.string().max(512), runId: z.string().uuid(), taskId: z.string().max(512).optional(), rpcId: z.string().max(INTERACTION_ID_LIMIT),
      answers: z.array(z.object({
        id: z.string().max(QUESTION_ID_LIMIT),
        selected: z.array(z.string().max(QUESTION_OPTION_LABEL_LIMIT)).max(10),
        custom: z.string().max(2_048).optional(),
      })).max(QUESTION_COUNT_LIMIT),
    }),
  }, guarded(input => manager.answerQuestion(input)))

  server.registerTool('dsh_answer_approval', {
    description: 'Resolve the current bounded DSH approval request. rpcId must match the current pending interaction; stale replies are rejected. When the observation says answerInWeb=true, resolve the oversized interaction in DSH Web instead.',
    inputSchema: z.object({
      sessionId: z.string().max(512), runId: z.string().uuid(), taskId: z.string().max(512).optional(), rpcId: z.string().max(INTERACTION_ID_LIMIT),
      outcome: z.enum(['allowed-once', 'rejected']),
    }),
  }, guarded(input => manager.answerApproval(input)))

  server.registerTool('dsh_cancel', {
    description: 'Cancel the active DSH root turn without stopping the Host.',
    inputSchema: z.object({ sessionId: z.string().max(512), runId: z.string().uuid(), taskId: z.string().max(512).optional() }),
  }, guarded(input => manager.cancel(input)))

  server.registerTool('dsh_agents', {
    description: 'Read-only current-run direct-child observability with per-child telemetry. Historical children not affiliated with the addressed run are excluded. DSH root remains the manager and automatically receives child reports; listing a settled child never authorizes steering root.',
    inputSchema: z.object({ sessionId: z.string().max(512), runId: z.string().uuid(), taskId: z.string().max(512).optional() }),
  }, guarded(input => manager.agents(input)))

  server.registerTool('dsh_interrupt_agent', {
    description: 'Emergency interrupt for one continuable direct child affiliated with the addressed run. Historical, unrelated, and one-shot targets are rejected. Use only on explicit human request or a clear safety/resource emergency, never for routine completion or orchestration; DSH root owns child control.',
    inputSchema: z.object({
      sessionId: z.string().max(512), runId: z.string().uuid(), taskId: z.string().max(512).optional(), childSessionId: z.string().max(512),
    }),
  }, guarded(input => manager.interruptAgent(input)))

  server.server.onclose = () => { manager.stopClients() }

  return server
}
