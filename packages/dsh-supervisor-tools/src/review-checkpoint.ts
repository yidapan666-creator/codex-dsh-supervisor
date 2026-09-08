/** A review is a blocking native question; only its successful tool result releases the gate. */
export interface ReviewProposal {
  sessionId: string
  runId: string
  category: 'approach' | 'public_interface' | 'plan_change' | 'risk'
  proposal: string
  rationale: string
}

export interface ReviewQuestionChannel {
  ask(input: {
    questions: Array<{
      id: string; header: string; question: string; detail: string
      options: Array<{ label: string; description: string }>
      intent: { kind: 'plan-review'; approve: string }
    }>
    agent: unknown
    signal: AbortSignal
  }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
}

export async function awaitSupervisorReview(
  channel: ReviewQuestionChannel,
  args: ReviewProposal,
  execution: { agent: unknown; signal: AbortSignal },
  questionId: string,
): Promise<{ approved: boolean; sessionId: string; runId: string; feedback: string }> {
  if (!['approach', 'public_interface', 'plan_change', 'risk'].includes(args.category)
    || !args.proposal.trim() || args.proposal.length > 768
    || !args.rationale.trim() || args.rationale.length > 768) {
    throw new Error('supervisor_review requires a category and non-empty proposal/rationale of at most 768 characters each')
  }
  const detail = `## Proposal\n${args.proposal}\n\n## Rationale\n${args.rationale}`
  if (detail.length > 1024) {
    throw new Error('supervisor_review proposal and rationale together must fit 997 characters; shorten them without omitting the decision or material risk')
  }
  const answer = await channel.ask({
    questions: [{
      id: questionId,
      header: 'DSH review',
      question: `[${args.category}] Approve this engineering proposal?`,
      detail,
      options: [
        { label: 'Approve', description: 'Approve this proposal within existing task scope and permissions.' },
        { label: 'Revise', description: 'Keep execution gated; submit a revised proposal before implementation.' },
      ],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }],
    agent: execution.agent,
    signal: execution.signal,
  })
  const response = answer.answers.length === 1 ? answer.answers[0] : undefined
  const approved = !execution.signal.aborted && response?.id === questionId
    && response.selected.length === 1 && response.selected[0] === 'Approve'
    && !response.custom?.trim()
  return {
    approved,
    sessionId: args.sessionId,
    runId: args.runId,
    feedback: (response?.custom ?? (approved ? 'Proposal approved within existing authority.' : 'Revise and request review again.')).slice(0, 1024),
  }
}

interface Event { type: string; seq: number; data: unknown }
function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}
function parsed(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return object(value)
  try { return object(JSON.parse(value)) } catch { return {} }
}

/** Fold Standard and PTC calls, retaining rejected/cancelled reviews across continuation runs. */
export function reviewCheckpointPending(events: readonly Event[], sessionId: string, runIds: ReadonlySet<string>): boolean {
  let latest: { callId: string; runId: string; approved: boolean } | undefined
  for (const event of events) {
    const data = object(event.data)
    if (event.type === 'tool/call' || event.type === 'tool/code-dispatch-start') {
      if (data.name !== 'supervisor_review') continue
      const args = parsed(data.arguments)
      const callId = event.type === 'tool/call' ? data.callId : data.subCallId
      if (args.sessionId === sessionId && typeof args.runId === 'string' && runIds.has(args.runId)
        && typeof callId === 'string') latest = { callId, runId: args.runId, approved: false }
      continue
    }
    if (latest === undefined) continue
    let content: unknown
    if (event.type === 'tool/result') {
      const message = object(data.message)
      if (object(message.source).callId !== latest.callId || data.error !== undefined) continue
      const block = Array.isArray(message.content)
        ? message.content.find(entry => object(entry).type === 'tool-result') : undefined
      if (object(block).isError !== false) continue
      content = object(block).content
    } else if (event.type === 'tool/code-dispatch') {
      if (data.subCallId !== latest.callId || data.isError !== false) continue
      content = data.content
    } else continue
    const text = Array.isArray(content)
      ? content.map(entry => object(entry).type === 'text' ? object(entry).text : '').join('') : ''
    const result = parsed(text)
    latest.approved = result.approved === true && result.sessionId === sessionId && result.runId === latest.runId
  }
  return latest !== undefined && !latest.approved
}

/** Unknown tools (including shells and dispatch wrappers) fail closed while review is outstanding. */
export function allowedDuringReview(name: string, args: unknown, isRoot: boolean): boolean {
  // Code-mode exposes only run_code. Permit a single literal SDK call, never
  // arbitrary wrapper code; the native guard also checks the nested execution.
  if (name === 'run_code') {
    const code = object(args).code
    if (typeof code !== 'string') return false
    const match = /^\s*return\s+await\s+tools\.([a-z_]+)\((\{[\s\S]*\})\)\s*;?\s*$/.exec(code)
    if (match === null || match[1] === 'run_code') return false
    try { return allowedDuringReview(match[1]!, JSON.parse(match[2]!), isRoot) } catch { return false }
  }
  if (['read', 'read_image', 'glob', 'grep'].includes(name)) return true
  if (name === 'str_replace_editor') return object(args).command === 'view'
  if (!isRoot) return false
  if (['supervisor_review', 'supervisor_progress', 'supervisor_report_failure'].includes(name)) return true
  return name === 'supervisor_handoff'
    && ['blocked', 'major_checkpoint', 'escalation_required', 'failed'].includes(String(object(args).status))
}
