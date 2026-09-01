import type { ExecutionBrief, ExecutionBriefInput, TaskPacketV2 } from './contracts.js'
import { executionBriefInputSchema, executionBriefSchema, TASK_PACKET_END, TASK_PACKET_START } from './contracts.js'

export const TASK_INSTRUCTION_PROFILE = 'engineering-v1' as const
export const DEFAULT_MAX_DIRECT_CHILDREN = 5

const DEFAULT_CONSTRAINTS = [
  'Stay inside the objective and workspace scope; preserve unrelated behavior and pre-existing user changes.',
  'Do not perform destructive history changes, credential operations, external publication, or other irreversible side effects without an explicit grant.',
  'Make coherent engineering changes rather than speculative rewrites; investigate evidence before patching an unclear failure.',
]

const DEFAULT_ACCEPTANCE = [
  'The objective is fully implemented, including material edge cases discovered during the work.',
  'Relevant verification passes, or every unavailable/failing check is reported precisely without claiming completion.',
  'The final handoff identifies changed files, verification performed, remaining risks, and any admitted artifacts.',
]

const DEFAULT_VERIFICATION = [
  'Run the narrowest relevant test/typecheck/build after coherent changes, then the repository standard full verification before handoff when available.',
]

const DEFAULT_ESCALATION = [
  'Escalate only for a material ambiguity that changes architecture, acceptance, or requested scope; an out-of-scope change; a security/destructive/credential/external side effect; or a blocker that cannot be resolved within the reported-failure recovery budget.',
]

export interface TaskInstructionInput {
  writerMode: 'writer' | 'read_only'
  allowedScope?: string[] | undefined
  constraints?: string[] | undefined
  acceptanceCriteria?: string[] | undefined
  verification?: string[] | undefined
  escalationConditions?: string[] | undefined
  authority?: TaskPacketV2['authority'] | undefined
}

/** Persist a bounded Codex decomposition, or make the compatibility fallback explicit. */
export function normalizeExecutionBrief(objective: string, input?: ExecutionBriefInput): ExecutionBrief {
  if (input === undefined) {
    return executionBriefSchema.parse({
      schemaVersion: 1,
      source: 'SINGLE_STREAM_FALLBACK',
      workstreams: [{
        id: 'W1',
        outcome: objective.slice(0, 512),
        delegation: 'root',
        doneWhen: ['The task-level acceptance criteria and verification requirements are satisfied.'],
      }],
      integration: ['Root owns implementation coherence, final verification, and the authoritative supervisor handoff.'],
    })
  }
  const parsed = executionBriefInputSchema.parse(input)
  return executionBriefSchema.parse({ schemaVersion: 1, source: 'CODEX_COMPILED', ...parsed })
}

function explicitOrDefault(value: string[] | undefined, fallback: readonly string[]): string[] {
  return value === undefined || value.length === 0 ? [...fallback] : value
}

/** Fill operational details deterministically; explicit caller instructions always win. */
export function normalizeTaskInstructions(input: TaskInstructionInput): Required<Pick<
TaskInstructionInput, 'constraints' | 'acceptanceCriteria' | 'verification' | 'escalationConditions'
>> & Pick<TaskInstructionInput, 'allowedScope' | 'authority'> {
  return {
    ...input.writerMode === 'writer'
      ? { allowedScope: input.allowedScope === undefined || input.allowedScope.length === 0 ? ['.'] : input.allowedScope }
      : input.allowedScope === undefined ? {} : { allowedScope: input.allowedScope },
    constraints: explicitOrDefault(input.constraints, DEFAULT_CONSTRAINTS),
    acceptanceCriteria: explicitOrDefault(input.acceptanceCriteria, DEFAULT_ACCEPTANCE),
    verification: explicitOrDefault(input.verification, DEFAULT_VERIFICATION),
    escalationConditions: explicitOrDefault(input.escalationConditions, DEFAULT_ESCALATION),
    authority: {
      ...input.authority,
      maxDirectChildren: input.authority?.maxDirectChildren ?? DEFAULT_MAX_DIRECT_CHILDREN,
    },
  }
}

/** Compile one bounded, durable worker prompt without an extra model call. */
export function compileTaskPrompt(packet: TaskPacketV2): string {
  const continuation = packet.recoveryCapsule === undefined
    ? ''
    : '\n- This is a recovery continuation. Reconcile every uncertain effect before any retry; never blindly replay an unresolved call.'
  return `${packet.objective}\n\n/dsh-supervised-worker\n\n`
    + `${TASK_PACKET_START}\n${JSON.stringify(packet)}\n${TASK_PACKET_END}\n\n`
    + `<dsh-execution-contract profile="${TASK_INSTRUCTION_PROFILE}">\n`
    + '- Treat the task packet as the binding scope, authority, acceptance, verification, and escalation contract; the human objective remains primary.\n'
    + '- Work in this order: inspect evidence; choose the smallest coherent approach; implement within scope; run focused verification after coherent edits; run the declared/full verification before handoff.\n'
    + '- Resolve routine in-scope engineering choices yourself. Use granted direct children only when useful, retain Root ownership, and integrate their results before the final handoff.\n'
    + '- Treat executionBrief as a bounded work map, not extra authority or a rigid script. Respect dependencies; validate assumptions; delegate child_candidate workstreams only when useful; and keep shared interfaces, cross-stream conflicts, integration, and final verification under Root ownership.\n'
    + '- Cover every workstream doneWhen condition and every integration item in the final handoff. Do not create separate supervised Roots for these workstreams.\n'
    + '- Do not ask again for ordinary edits, compilation, tests, builds, debugging, or child use already authorized by the packet. Escalate only under the packet conditions.\n'
    + '- Completion requires a successful supervisor_handoff with matching sessionId, runId, and completionToken, followed by this Root turn ending. A plain turn end is not success.\n'
    + '- Artifact paths are relative to the session cwd. Report repeated recovery failures with a stable worker-chosen failureSignature. The Host enforces the task token budget while the supervisor is disconnected.'
    + continuation
    + '\n</dsh-execution-contract>'
}
