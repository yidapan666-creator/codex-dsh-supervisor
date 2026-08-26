import { describe, expect, it } from 'vitest'
import { DEFAULT_DECISION_POLICY, evaluateDecision, parseDecisionPolicy } from '../src/index.js'

describe('decision policy', () => {
  it('keeps protocol terminal and interaction boundaries immediate and non-overridable', () => {
    expect(evaluateDecision({ signal: 'APPROVAL' })).toMatchObject({
      timing: 'immediate', action: 'RESOLVE_INTERACTION', protocolInvariant: true,
    })
    expect(evaluateDecision({ signal: 'TERMINAL_SUCCESS' })).toMatchObject({
      timing: 'immediate', action: 'ACCEPT_TERMINAL', protocolInvariant: true,
    })
  })

  it('routes sensitive/high-impact worker decisions to the human with an explanation', () => {
    expect(evaluateDecision({
      signal: 'WORKER_DECISION', category: 'security', impact: 'medium', blocking: false,
    })).toMatchObject({
      timing: 'immediate', audience: 'human', action: 'ASK_HUMAN',
      matchedRuleId: 'worker.sensitive', reasonCode: 'SENSITIVE_OR_SCOPE_DECISION',
      protocolInvariant: false,
    })
  })

  it('keeps low-impact non-blocking worker decisions in the cadence', () => {
    expect(evaluateDecision({
      signal: 'WORKER_DECISION', category: 'information', impact: 'low', blocking: false,
    })).toMatchObject({
      timing: 'cadence', audience: 'supervisor', action: 'SURFACE_PROGRESS',
      matchedRuleId: 'worker.fallback',
    })
  })

  it('lets explicit task authorization suppress a worker escalation', () => {
    expect(evaluateDecision({
      signal: 'WORKER_DECISION', category: 'architecture', impact: 'high', blocking: true,
      explicitlyPreAuthorized: true,
    })).toMatchObject({
      timing: 'cadence', audience: 'none', action: 'CONTINUE_WAIT', matchedRuleId: 'worker.pre_authorized',
    })
  })

  it('never lets pre-authorization suppress a sensitive or explicitly human request', () => {
    expect(evaluateDecision({
      signal: 'WORKER_DECISION', category: 'credentials', impact: 'low', blocking: false,
      explicitlyPreAuthorized: true,
    })).toMatchObject({ timing: 'immediate', audience: 'human', matchedRuleId: 'worker.sensitive' })
    expect(evaluateDecision({
      signal: 'WORKER_DECISION', category: 'information', impact: 'low', blocking: false,
      requiresHuman: true, explicitlyPreAuthorized: true,
    })).toMatchObject({ timing: 'immediate', audience: 'human', matchedRuleId: 'worker.explicit_human' })
  })

  it('parses JSON policy overrides and rejects duplicate rule ids', () => {
    const policy = parseDecisionPolicy({
      version: 'test.v1',
      workerRules: [{
        id: 'custom', priority: 1, when: { categories: ['architecture'] },
        effect: { timing: 'cadence', audience: 'supervisor', action: 'SURFACE_PROGRESS', reasonCode: 'CUSTOM' },
      }],
      workerFallback: DEFAULT_DECISION_POLICY.workerFallback,
    })
    expect(evaluateDecision({ signal: 'WORKER_DECISION', category: 'architecture' }, policy))
      .toMatchObject({ matchedRuleId: 'custom', reasonCode: 'CUSTOM' })
    expect(() => parseDecisionPolicy({
      version: 'bad',
      workerRules: [
        { id: 'same', priority: 1, when: {}, effect: DEFAULT_DECISION_POLICY.workerFallback },
        { id: 'same', priority: 2, when: {}, effect: DEFAULT_DECISION_POLICY.workerFallback },
      ],
      workerFallback: DEFAULT_DECISION_POLICY.workerFallback,
    })).toThrow(/unique id/)
  })
})
