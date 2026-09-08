import { describe, expect, it, vi } from 'vitest'
import { allowedDuringReview, awaitSupervisorReview, reviewCheckpointPending, type ReviewQuestionChannel } from '../src/review-checkpoint.js'
import { apply, supervisorReviewGuard } from '../src/index.js'

const runId = '11111111-1111-4111-8111-111111111111'
const nextId = '22222222-2222-4222-8222-222222222222'
const proposal = { sessionId: 'root', runId, category: 'approach' as const, proposal: 'API: preserve schema; add validation before dispatch.', rationale: 'API doneWhen[0]; inspect src/api.ts; rejects invalid inputs before effects.' }
type Event = { type: string; seq: number; time: number; data: unknown }
function packet(id = runId, parentRunId?: string, mode = 'reviewed'): Event {
  return { type: 'user/message', seq: id === runId ? 0 : 10, time: id === runId ? 100 : 200, data: { content: [{ type: 'text', text: `<dsh-supervised-task>\n${JSON.stringify({
    schemaVersion: 2, sessionId: 'root', runId: id, parentRunId, completionToken: runId,
    objective: 'Validate API', writerMode: 'writer', supervisionMode: mode,
  })}\n</dsh-supervised-task>` }] } }
}
function call(id = 'review-1', run = runId, ptc = false, seq = 1): Event {
  return { type: ptc ? 'tool/code-dispatch-start' : 'tool/call', seq, time: 100 + seq,
    data: { name: 'supervisor_review', ...(ptc ? { subCallId: id, arguments: { ...proposal, runId: run } } : { callId: id, arguments: JSON.stringify({ ...proposal, runId: run }) }) } }
}
function result(approved: boolean, id = 'review-1', run = runId, ptc = false, seq = 2, isError = false): Event {
  const content = [{ type: 'text', text: JSON.stringify({ approved, sessionId: 'root', runId: run }) }]
  return { type: ptc ? 'tool/code-dispatch' : 'tool/result', seq, time: 100 + seq, data: ptc
    ? { subCallId: id, isError, content }
    : { message: { source: { callId: id }, content: [{ type: 'tool-result', isError, content }] } } }
}
const execution = () => ({ agent: {}, signal: new AbortController().signal })

describe('blocking native supervisor review', () => {
  it('registers an exclusive tool with Root identity checks, a native question and durable JSON approval', async () => {
    type Tool = { name: string; isConcurrencySafe?: unknown; execute: (args: unknown, exec: unknown) => Promise<unknown>; output: { render: (args: unknown, value: unknown) => unknown } }
    const registered = new Map<string, Tool>()
    let ptc = false
    const guards: Array<(execution: unknown) => unknown> = []
    const root = { header: { id: 'root' }, events: [packet(), call()] }
    const ask = vi.fn<ReviewQuestionChannel['ask']>(async input => ({ answers: [{ id: input.questions[0]!.id, selected: ['Approve'] }] }))
    vi.stubEnv('DSH_HOST_TOKEN', 'local-unit-fixture-credential-not-used-over-network')
    try {
      apply({
        tools: { get: (name: string) => ptc && name === 'run_code' ? {} : undefined, register: (tool: Tool) => registered.set(tool.name, tool), guard: (guard: (execution: unknown) => unknown) => guards.push(guard) },
        systemPrompt: { section() {} }, sessions: { list: () => [root] }, agents: { list: () => [] },
        sessionPersistence: {}, apiProxy: {}, sandboxPolicy: { defaultMode: 'workspace-write' }, approval: { config: { policy: 'ask' } },
        on() {}, effect() {}, get: (name: string) => name === 'userQuestions' ? { ask } : undefined,
      } as never)
      const review = registered.get('supervisor_review')!
      expect(review).toBeDefined()
      expect(review.isConcurrencySafe).not.toBe(true)
      const exec = { agent: { session: root }, signal: new AbortController().signal, callId: 'review-1' }
      await expect(review.execute({ ...proposal, runId: nextId }, exec)).rejects.toThrow(/current reviewed Root/)
      await expect(review.execute(proposal, { ...exec, agent: { session: { ...root, header: { id: 'child', parentSession: 'root' } } } })).rejects.toThrow(/current reviewed Root/)
      root.events = [packet(runId, undefined, 'delegated')]
      await expect(review.execute(proposal, exec)).rejects.toThrow(/current reviewed Root/)
      expect(ask).not.toHaveBeenCalled()
      root.events = [packet(), call()]
      ptc = true
      await expect(review.execute(proposal, exec)).rejects.toThrow(/requires Standard/)
      expect(ask).not.toHaveBeenCalled()
      ptc = false
      const value = await review.execute(proposal, exec)
      expect(ask.mock.calls[0]?.[0].questions[0]?.id).toMatch(/^dsh-review:/)
      expect(ask.mock.calls[0]?.[0].questions[0]?.detail).toContain(proposal.proposal)
      expect(ask.mock.calls[0]?.[0].questions[0]?.detail).toContain(proposal.rationale)
      const content = review.output.render(proposal, value)
      const check = () => guards[0]?.({ name: 'write', token: Symbol(), agent: exec.agent })
      expect(check()).toContain('review-pending')
      root.events.push({ type: 'tool/result', seq: 2, time: 102, data: {
        message: { source: { callId: 'review-1' }, content: [{ type: 'tool-result', isError: false, content }] },
      } })
      expect(check()).toBeUndefined()
    } finally { vi.unstubAllEnvs() }
  })

  it('does not resolve until the exact question is answered and passes cancellation through', async () => {
    let answer!: (value: Awaited<ReturnType<ReviewQuestionChannel['ask']>>) => void
    const ask = vi.fn(() => new Promise<Awaited<ReturnType<ReviewQuestionChannel['ask']>>>(resolve => { answer = resolve }))
    const exec = execution()
    const settled = vi.fn()
    const pending = awaitSupervisorReview({ ask }, proposal, exec, 'dsh-review:test').then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(ask.mock.calls[0]?.[0]).toMatchObject({ signal: exec.signal, agent: exec.agent })
    answer({ answers: [{ id: 'dsh-review:test', selected: ['Approve'] }] })
    await pending
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ approved: true, runId }))
  })

  it.each([
    [{ id: 'q', selected: ['Revise'] }],
    [{ id: 'stale', selected: ['Approve'] }],
    [{ id: 'q', selected: ['Approve'], custom: 'Only if you change the API' }],
    [{ id: 'q', selected: ['Approve', 'Revise'] }],
    [{ id: 'q', selected: [], custom: 'Preserve the old entry point' }],
    [],
  ])('does not treat non-exact approval as permission: %j', async (...answers) => {
    const result = await awaitSupervisorReview({ ask: async () => ({ answers }) } as ReviewQuestionChannel, proposal, execution(), 'q')
    expect(result.approved).toBe(false)
  })

  it('does not swallow cancellation or approve an aborted execution', async () => {
    await expect(awaitSupervisorReview({ ask: async () => { throw new Error('ASK_CANCELLED') } }, proposal, execution(), 'q')).rejects.toThrow('ASK_CANCELLED')
    const controller = new AbortController(); controller.abort()
    expect((await awaitSupervisorReview({ ask: async () => ({ answers: [{ id: 'q', selected: ['Approve'] }] }) }, proposal, { agent: {}, signal: controller.signal }, 'q')).approved).toBe(false)
  })

  it('keeps proposals in the MCP question envelope and rejects oversize before asking', async () => {
    const ask = vi.fn<ReviewQuestionChannel['ask']>(async input => {
      const q = input.questions[0]!
      expect(q.question.length).toBeLessThanOrEqual(1024)
      expect(q.detail.length).toBeLessThanOrEqual(1024)
      expect(q.detail).toContain('## Proposal')
      expect(q.detail).toContain('## Rationale')
      return { answers: [{ id: q.id, selected: ['Approve'] }] }
    })
    await awaitSupervisorReview({ ask }, { ...proposal, proposal: 'p'.repeat(768), rationale: 'r'.repeat(229) }, execution(), 'q')
    await expect(awaitSupervisorReview({ ask }, { ...proposal, proposal: 'p'.repeat(769) }, execution(), 'q')).rejects.toThrow('768')
    await expect(awaitSupervisorReview({ ask }, { ...proposal, proposal: 'p'.repeat(768), rationale: 'r'.repeat(230) }, execution(), 'q')).rejects.toThrow('997')
    expect(ask).toHaveBeenCalledTimes(1)
  })
})

describe('durable review execution gate', () => {
  it.each([false, true])('requires the corresponding successful Standard/PTC result (PTC=%s)', ptc => {
    const events = [call('a', runId, ptc)]
    const pending = () => reviewCheckpointPending(events, 'root', new Set([runId]))
    expect(pending()).toBe(true)
    events.push(result(true, 'other', runId, ptc)); expect(pending()).toBe(true)
    events.push(result(true, 'a', nextId, ptc)); expect(pending()).toBe(true)
    events.push(result(true, 'a', runId, ptc, 3, true)); expect(pending()).toBe(true)
    events.push(result(false, 'a', runId, ptc)); expect(pending()).toBe(true)
    events.push({ type: 'user/message', seq: 5, time: 105, data: { content: [{ type: 'text', text: 'Go ahead' }] } }); expect(pending()).toBe(true)
    events.push(result(true, 'a', runId, ptc)); expect(pending()).toBe(false)
    events.push(call('new', runId, ptc)); expect(pending()).toBe(true)
    events.push(result(true, 'a', runId, ptc)); expect(pending()).toBe(true)
  })

  it('blocks Root and current children, preserves pending review across continuation, and isolates unrelated runs', () => {
    const root = { header: { id: 'root', createdAt: 90 }, events: [packet(), call()] }
    const child = { header: { id: 'child', parentSession: 'root', createdAt: 105 }, events: [{ type: 'user/message', seq: 0, time: 106, data: { content: [{ type: 'text', text: 'Work on API' }] } }] }
    const unrelated = { header: { id: 'other', createdAt: 105 }, events: [] }
    const historical = { header: { id: 'old-child', parentSession: 'root', createdAt: 50 }, events: [{ type: 'user/message', seq: 0, time: 60, data: {} }] }
    const sessions = [root, child, unrelated, historical]
    const check = (session: typeof root | typeof child, name = 'write', args: unknown = {}) => supervisorReviewGuard(sessions, { name, arguments: args, token: Symbol(), agent: { session, cancel() {} } })
    expect(check(root)).toContain('review-pending')
    expect(check(child)).toContain('review-pending')
    expect(check(unrelated)).toBeUndefined()
    expect(check(historical)).toBeUndefined()
    expect(check(root, 'subagent')).toContain('review-pending')
    expect(check(root, 'supervisor_handoff', { status: 'completed' })).toContain('review-pending')
    expect(check(root, 'supervisor_handoff', { status: 'blocked' })).toBeUndefined()
    expect(check(child, 'supervisor_review')).toContain('review-pending')
    expect(check(root, 'read')).toBeUndefined()
    root.events.push(packet(nextId, runId))
    expect(check(root)).toContain('review-pending')
    expect(check(child)).toContain('review-pending')
    root.events.push(call('fresh', nextId, false, 11), result(true, 'fresh', nextId, false, 12))
    expect(check(root)).toBeUndefined()
    root.events = [packet(), call(), packet(nextId)]
    expect(check(root)).toBeUndefined()
    root.events = [packet(runId, undefined, 'delegated'), call()]
    expect(check(root)).toBeUndefined()
  })

  it('allows only known reads and a single literal Code SDK call, never an execution wrapper bypass', () => {
    expect(allowedDuringReview('str_replace_editor', { command: 'view' }, false)).toBe(true)
    for (const name of ['write', 'bash', 'shell', 'subagent', 'unknown']) expect(allowedDuringReview(name, {}, true)).toBe(false)
    const code = `return await tools.supervisor_review(${JSON.stringify(proposal)})`
    expect(allowedDuringReview('run_code', { code }, true)).toBe(true)
    expect(allowedDuringReview('run_code', { code }, false)).toBe(false)
    expect(allowedDuringReview('run_code', { code: 'return await tools.read({"file_path":"src/api.ts"})' }, false)).toBe(true)
    for (const value of [code + '\nprint(1)', 'return await tools.write({"file_path":"src/api.ts"})', 'return await tools.read({"file_path":danger()})', 'import os\n' + code, 'return await tools.run_code({"code":"something"})']) {
      expect(allowedDuringReview('run_code', { code: value }, true)).toBe(false)
    }
  })
})
