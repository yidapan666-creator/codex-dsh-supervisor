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

function latestTaskBoundary(events: readonly { type: string; data: unknown }[]): number {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const data = event.data as { content?: unknown; message?: { content?: unknown } }
    if (contentText(data.content ?? data.message?.content).includes(TASK_PACKET_START)) return index
  }
  return 0
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
      + '`supervisor_handoff` exactly once with the task id and completion token from the task packet. '
      + 'A normal turn ending without that valid handoff is not success. Report repeated failures through '
      + '`supervisor_report_failure`; its budget is enforced from your reported failureSignature, while deciding '
      + 'whether two failures are semantically the same remains your responsibility.',
  })

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
      + 'only when taskId and completionToken match the task packet and this successful tool result is followed by '
      + 'the corresponding turn/end event.',
    parameters: {
      taskId: { type: 'string', required: true },
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
      if (args.summary.length > 2_048) throw new Error('handoff summary exceeds 2048 characters')
      if (exec.agent === undefined) throw new Error('supervisor_handoff requires an agent-owned session')
      const artifacts = await admitArtifacts(exec.agent.session.header.cwd, args.artifacts)
      const handoff = {
        taskId: args.taskId,
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
