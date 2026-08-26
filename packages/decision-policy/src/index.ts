export const DECISION_CATEGORIES = [
  'architecture', 'scope', 'acceptance', 'security', 'destructive_action',
  'credentials', 'external_side_effect', 'recovery', 'information', 'unspecified',
] as const
export type DecisionCategory = typeof DECISION_CATEGORIES[number]

export const DECISION_IMPACTS = ['low', 'medium', 'high'] as const
export type DecisionImpact = typeof DECISION_IMPACTS[number]

export type DecisionSignal =
  | 'WAIT'
  | 'PROGRESS'
  | 'APPROVAL'
  | 'QUESTION'
  | 'WORKER_DECISION'
  | 'CHECKPOINT'
  | 'TERMINAL_SUCCESS'
  | 'TERMINAL_FAILURE'

export type DecisionTiming = 'cadence' | 'immediate'
export type DecisionAudience = 'none' | 'supervisor' | 'human'
export type DecisionAction =
  | 'CONTINUE_WAIT'
  | 'SURFACE_PROGRESS'
  | 'RESOLVE_INTERACTION'
  | 'REVIEW_WORKER_REQUEST'
  | 'ASK_HUMAN'
  | 'ACCEPT_TERMINAL'
  | 'REVIEW_FAILURE'
  | 'QUEUE_CONTINUATION'

export interface DecisionFacts {
  signal: DecisionSignal
  category?: DecisionCategory
  impact?: DecisionImpact
  blocking?: boolean
  requiresHuman?: boolean
  explicitlyPreAuthorized?: boolean
}

export interface DecisionEffect {
  timing: DecisionTiming
  audience: DecisionAudience
  action: DecisionAction
  reasonCode: string
}

export interface DecisionRule {
  id: string
  priority: number
  when: {
    categories?: DecisionCategory[]
    impacts?: DecisionImpact[]
    blocking?: boolean
    requiresHuman?: boolean
    explicitlyPreAuthorized?: boolean
  }
  effect: DecisionEffect
}

export interface DecisionPolicy {
  version: string
  workerRules: DecisionRule[]
  workerFallback: DecisionEffect
}

export interface DecisionOutcome extends DecisionEffect {
  policyVersion: string
  matchedRuleId: string
  protocolInvariant: boolean
}

const effect = (
  timing: DecisionTiming,
  audience: DecisionAudience,
  action: DecisionAction,
  reasonCode: string,
): DecisionEffect => ({ timing, audience, action, reasonCode })

/**
 * Safe default worker-decision policy. Protocol invariants (terminal and
 * interaction delivery) are intentionally not user-overridable.
 */
export const DEFAULT_DECISION_POLICY: DecisionPolicy = {
  version: '2026-08-26.v1',
  workerRules: [
    {
      id: 'worker.explicit_human', priority: 130,
      when: { requiresHuman: true },
      effect: effect('immediate', 'human', 'ASK_HUMAN', 'WORKER_REQUIRES_HUMAN'),
    },
    {
      id: 'worker.sensitive', priority: 120,
      when: { categories: ['security', 'destructive_action', 'credentials', 'external_side_effect', 'scope', 'acceptance'] },
      effect: effect('immediate', 'human', 'ASK_HUMAN', 'SENSITIVE_OR_SCOPE_DECISION'),
    },
    {
      id: 'worker.pre_authorized', priority: 100,
      when: { explicitlyPreAuthorized: true },
      effect: effect('cadence', 'none', 'CONTINUE_WAIT', 'PRE_AUTHORIZED'),
    },
    {
      id: 'worker.high_impact', priority: 90,
      when: { impacts: ['high'] },
      effect: effect('immediate', 'human', 'ASK_HUMAN', 'HIGH_IMPACT_DECISION'),
    },
    {
      id: 'worker.blocking', priority: 80,
      when: { blocking: true },
      effect: effect('immediate', 'supervisor', 'REVIEW_WORKER_REQUEST', 'BLOCKING_WORKER_DECISION'),
    },
  ],
  workerFallback: effect('cadence', 'supervisor', 'SURFACE_PROGRESS', 'NON_BLOCKING_WORKER_DECISION'),
}

const PROTOCOL_EFFECTS: Record<Exclude<DecisionSignal, 'WORKER_DECISION'>, DecisionEffect> = {
  WAIT: effect('cadence', 'none', 'CONTINUE_WAIT', 'ORDINARY_WAIT'),
  PROGRESS: effect('cadence', 'supervisor', 'SURFACE_PROGRESS', 'ORDINARY_PROGRESS'),
  APPROVAL: effect('immediate', 'supervisor', 'RESOLVE_INTERACTION', 'APPROVAL_PENDING'),
  QUESTION: effect('immediate', 'supervisor', 'RESOLVE_INTERACTION', 'QUESTION_PENDING'),
  CHECKPOINT: effect('immediate', 'supervisor', 'QUEUE_CONTINUATION', 'CHECKPOINT_REACHED'),
  TERMINAL_SUCCESS: effect('immediate', 'supervisor', 'ACCEPT_TERMINAL', 'TERMINAL_SUCCESS'),
  TERMINAL_FAILURE: effect('immediate', 'supervisor', 'REVIEW_FAILURE', 'TERMINAL_FAILURE'),
}

function matches(rule: DecisionRule, facts: DecisionFacts): boolean {
  const when = rule.when
  return (when.categories === undefined || (facts.category !== undefined && when.categories.includes(facts.category)))
    && (when.impacts === undefined || (facts.impact !== undefined && when.impacts.includes(facts.impact)))
    && (when.blocking === undefined || facts.blocking === when.blocking)
    && (when.requiresHuman === undefined || facts.requiresHuman === when.requiresHuman)
    && (when.explicitlyPreAuthorized === undefined || facts.explicitlyPreAuthorized === when.explicitlyPreAuthorized)
}

export function evaluateDecision(
  facts: DecisionFacts,
  policy: DecisionPolicy = DEFAULT_DECISION_POLICY,
): DecisionOutcome {
  if (facts.signal !== 'WORKER_DECISION') {
    return {
      ...PROTOCOL_EFFECTS[facts.signal],
      policyVersion: policy.version,
      matchedRuleId: `protocol.${facts.signal.toLowerCase()}`,
      protocolInvariant: true,
    }
  }
  const matched = [...policy.workerRules]
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .find(rule => matches(rule, facts))
  return {
    ...(matched?.effect ?? policy.workerFallback),
    policyVersion: policy.version,
    matchedRuleId: matched?.id ?? 'worker.fallback',
    protocolInvariant: false,
  }
}

const stringArray = (value: unknown, allowed: readonly string[], label: string): string[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && allowed.includes(item))) {
    throw new Error(`${label} must be an array of supported values`)
  }
  return value
}

function parseEffect(value: unknown, label: string): DecisionEffect {
  if (typeof value !== 'object' || value === null) throw new Error(`${label} must be an object`)
  const candidate = value as Record<string, unknown>
  if ((candidate.timing !== 'cadence' && candidate.timing !== 'immediate')
    || (candidate.audience !== 'none' && candidate.audience !== 'supervisor' && candidate.audience !== 'human')
    || !['CONTINUE_WAIT', 'SURFACE_PROGRESS', 'RESOLVE_INTERACTION', 'REVIEW_WORKER_REQUEST', 'ASK_HUMAN', 'ACCEPT_TERMINAL', 'REVIEW_FAILURE', 'QUEUE_CONTINUATION'].includes(String(candidate.action))
    || typeof candidate.reasonCode !== 'string' || candidate.reasonCode.trim() === '') {
    throw new Error(`${label} has an unsupported effect`)
  }
  return {
    timing: candidate.timing,
    audience: candidate.audience,
    action: candidate.action,
    reasonCode: candidate.reasonCode.trim(),
  } as DecisionEffect
}

/** Parse a JSON-compatible worker policy while leaving protocol invariants locked. */
export function parseDecisionPolicy(value: unknown): DecisionPolicy {
  if (typeof value !== 'object' || value === null) throw new Error('decision policy must be an object')
  const candidate = value as Record<string, unknown>
  if (typeof candidate.version !== 'string' || candidate.version.trim() === '') throw new Error('decision policy version is required')
  if (!Array.isArray(candidate.workerRules)) throw new Error('decision policy workerRules must be an array')
  const ids = new Set<string>()
  const workerRules = candidate.workerRules.map((raw, index): DecisionRule => {
    if (typeof raw !== 'object' || raw === null) throw new Error(`workerRules[${index}] must be an object`)
    const rule = raw as Record<string, unknown>
    if (typeof rule.id !== 'string' || rule.id.trim() === '' || ids.has(rule.id)) throw new Error(`workerRules[${index}] needs a unique id`)
    ids.add(rule.id)
    if (typeof rule.priority !== 'number' || !Number.isSafeInteger(rule.priority) || rule.priority < -10_000 || rule.priority > 10_000) {
      throw new Error(`workerRules[${index}].priority must be an integer between -10000 and 10000`)
    }
    if (typeof rule.when !== 'object' || rule.when === null) throw new Error(`workerRules[${index}].when must be an object`)
    const when = rule.when as Record<string, unknown>
    for (const key of ['blocking', 'requiresHuman', 'explicitlyPreAuthorized']) {
      if (when[key] !== undefined && typeof when[key] !== 'boolean') throw new Error(`workerRules[${index}].when.${key} must be boolean`)
    }
    return {
      id: rule.id,
      priority: rule.priority,
      when: {
        ...when.categories === undefined ? {} : { categories: stringArray(when.categories, DECISION_CATEGORIES, `workerRules[${index}].when.categories`) as DecisionCategory[] },
        ...when.impacts === undefined ? {} : { impacts: stringArray(when.impacts, DECISION_IMPACTS, `workerRules[${index}].when.impacts`) as DecisionImpact[] },
        ...when.blocking === undefined ? {} : { blocking: when.blocking as boolean },
        ...when.requiresHuman === undefined ? {} : { requiresHuman: when.requiresHuman as boolean },
        ...when.explicitlyPreAuthorized === undefined ? {} : { explicitlyPreAuthorized: when.explicitlyPreAuthorized as boolean },
      },
      effect: parseEffect(rule.effect, `workerRules[${index}].effect`),
    }
  })
  return {
    version: candidate.version,
    workerRules,
    workerFallback: parseEffect(candidate.workerFallback, 'workerFallback'),
  }
}
