import { describe, expect, it } from 'vitest'
import type { TaskPacketV2 } from '../src/contracts.js'
import {
  compileTaskPrompt, DEFAULT_MAX_DIRECT_CHILDREN, normalizeExecutionBrief, normalizeTaskInstructions,
  TASK_INSTRUCTION_PROFILE,
} from '../src/task-prompt.js'

describe('Codex-to-DSH task instruction compiler', () => {
  it('fills safe engineering defaults without a model call', () => {
    const value = normalizeTaskInstructions({ writerMode: 'writer' })
    expect(value.allowedScope).toEqual(['.'])
    expect(value.authority?.maxDirectChildren).toBe(DEFAULT_MAX_DIRECT_CHILDREN)
    expect(value.constraints).toEqual(expect.arrayContaining([expect.stringMatching(/preserve unrelated/)]))
    expect(value.acceptanceCriteria).toHaveLength(3)
    expect(value.verification[0]).toMatch(/narrowest relevant/)
    expect(value.escalationConditions[0]).toMatch(/material ambiguity/)
  })

  it('preserves explicit instructions and an explicit zero-child cap', () => {
    const value = normalizeTaskInstructions({
      writerMode: 'read_only',
      constraints: ['custom constraint'],
      acceptanceCriteria: ['custom acceptance'],
      verification: ['custom verify'],
      escalationConditions: ['custom escalation'],
      authority: { maxDirectChildren: 0 },
    })
    expect(value).toMatchObject({
      constraints: ['custom constraint'], acceptanceCriteria: ['custom acceptance'],
      verification: ['custom verify'], escalationConditions: ['custom escalation'],
      authority: { maxDirectChildren: 0 },
    })
    expect(value.allowedScope).toBeUndefined()
  })

  it('compiles the packet, execution order, and strict completion rule into one durable prompt', () => {
    const packet = {
      schemaVersion: 2,
      sessionId: 'session-1',
      runId: '11111111-1111-4111-8111-111111111111',
      completionToken: '22222222-2222-4222-8222-222222222222',
      objective: 'Fix the parser',
      writerMode: 'writer',
    } as TaskPacketV2
    const prompt = compileTaskPrompt(packet)
    expect(prompt).toContain(`profile="${TASK_INSTRUCTION_PROFILE}"`)
    expect(prompt).toContain('inspect evidence; choose the smallest coherent approach; implement within scope')
    expect(prompt).toContain('A plain turn end is not success')
    expect(prompt).toContain('Treat executionBrief as a bounded work map')
    expect(prompt).toContain(JSON.stringify(packet))
  })

  it('marks an omitted decomposition as an explicit single-stream fallback', () => {
    expect(normalizeExecutionBrief('Fix the parser')).toEqual({
      schemaVersion: 1,
      source: 'SINGLE_STREAM_FALLBACK',
      workstreams: [{
        id: 'W1', outcome: 'Fix the parser', delegation: 'root',
        doneWhen: ['The task-level acceptance criteria and verification requirements are satisfied.'],
      }],
      integration: ['Root owns implementation coherence, final verification, and the authoritative supervisor handoff.'],
    })
  })

  it('persists a bounded Codex decomposition and rejects invalid dependency graphs', () => {
    const brief = normalizeExecutionBrief('Harden authentication', {
      workstreams: [
        {
          id: 'AUTH', outcome: 'Define the token lifecycle', delegation: 'child_candidate',
          doneWhen: ['Refresh behavior is covered by focused tests.'],
        },
        {
          id: 'RECONNECT', outcome: 'Reconnect with the same durable session', dependsOn: ['AUTH'],
          delegation: 'child_candidate', doneWhen: ['Two managers reconnect to the same session.'],
        },
      ],
      integration: ['Root resolves shared interfaces and runs the complete verification suite.'],
    })
    expect(brief).toMatchObject({ source: 'CODEX_COMPILED', workstreams: [{ id: 'AUTH' }, { id: 'RECONNECT' }] })
    expect(() => normalizeExecutionBrief('cycle', {
      workstreams: [
        { id: 'A', outcome: 'A', dependsOn: ['B'], delegation: 'root', doneWhen: ['A done'] },
        { id: 'B', outcome: 'B', dependsOn: ['A'], delegation: 'root', doneWhen: ['B done'] },
      ],
      integration: ['Integrate.'],
    })).toThrow(/acyclic/)
  })
})
