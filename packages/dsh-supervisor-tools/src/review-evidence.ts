/** Worker claims and evidence locators, never Host-verified acceptance. */
export interface ReviewEvidence {
  criteria: Array<{ workstreamId: string; doneWhenIndex: number; status: 'met' | 'unmet' | 'unknown'; evidence: string }>
  planChanges: string[]
  negativeEvidence: string[]
  evidencePaths: string[]
  omitted: { criteria: number; planChanges: number; negativeEvidence: number; evidencePaths: number }
}

const objectWithKeys = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => key in value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
const count = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const path = (value: unknown): boolean => text(value) && !value.startsWith('/') && !value.includes('\\')
  && !/^[A-Za-z]:/.test(value) && !/[\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(part => part !== '' && part !== '..' && part !== '.')

/** Check bounded shape at the Host execution boundary, including programmatic calls. */
export function reviewEvidenceError(value: unknown, maxCriteria = 8): string | undefined {
  if (!objectWithKeys(value, ['criteria', 'planChanges', 'negativeEvidence', 'evidencePaths', 'omitted'])) {
    return 'reviewEvidence requires criteria, planChanges, negativeEvidence, evidencePaths and omitted'
  }
  if (!Array.isArray(value.criteria) || value.criteria.length > maxCriteria || value.criteria.some(item =>
    !objectWithKeys(item, ['workstreamId', 'doneWhenIndex', 'status', 'evidence'])
    || typeof item.workstreamId !== 'string' || !/^[A-Z][A-Z0-9_-]{0,15}$/.test(item.workstreamId)
    || !count(item.doneWhenIndex) || !['met', 'unmet', 'unknown'].includes(String(item.status)) || !text(item.evidence))) {
    return `reviewEvidence.criteria requires at most ${maxCriteria} bounded criterion claims`
  }
  for (const [key, max] of [['planChanges', 3], ['negativeEvidence', 5], ['evidencePaths', 8]] as const) {
    if (!Array.isArray(value[key]) || value[key].length > max || value[key].some(item => key === 'evidencePaths' ? !path(item) : !text(item))) {
      return `reviewEvidence.${key} exceeds its bound or contains an invalid entry`
    }
  }
  if (!objectWithKeys(value.omitted, ['criteria', 'planChanges', 'negativeEvidence', 'evidencePaths'])
    || Object.values(value.omitted).some(value => !count(value))) return 'reviewEvidence.omitted requires nonnegative counts'
  return undefined
}

/** The final table is complete, not a delta; statuses remain worker claims. */
export function finalReviewError(value: unknown, workstreams: unknown): string | undefined {
  const shapeError = reviewEvidenceError(value, 40)
  if (shapeError !== undefined) return shapeError
  if (!Array.isArray(workstreams) || workstreams.length === 0 || workstreams.length > 5) return 'finalReview has no valid executionBrief'
  const expected = new Set<string>()
  const streamIds = new Set<string>()
  for (const stream of workstreams) {
    if (typeof stream !== 'object' || stream === null || typeof stream.id !== 'string'
      || !/^[A-Z][A-Z0-9_-]{0,15}$/.test(stream.id) || streamIds.has(stream.id)
      || !Array.isArray(stream.doneWhen) || stream.doneWhen.length === 0 || stream.doneWhen.length > 8
      || stream.doneWhen.some((item: unknown) => typeof item !== 'string' || item.trim() === '')) {
      return 'finalReview has an invalid executionBrief workstream'
    }
    streamIds.add(stream.id)
    for (let index = 0; index < stream.doneWhen.length; index++) expected.add(`${stream.id}:${index}`)
  }
  const review = value as ReviewEvidence
  const seen = new Set<string>()
  for (const claim of review.criteria) {
    const key = `${claim.workstreamId}:${claim.doneWhenIndex}`
    if (!expected.has(key) || seen.has(key)) return 'finalReview contains an unknown or duplicate doneWhen reference'
    if (claim.status !== 'met') return 'finalReview has unmet or unknown criteria; report blocked or failed'
    if (claim.evidence.trim() === '') return 'finalReview requires nonempty evidence for every criterion'
    seen.add(key)
  }
  if (seen.size !== expected.size) return 'finalReview must cover every executionBrief doneWhen exactly once'
  if (Object.values(review.omitted).some(count => count !== 0)) return 'finalReview cannot omit evidence; compact the table and put supporting detail in admitted artifacts'
  if (review.negativeEvidence.length > 0) return 'finalReview has unresolved negative evidence; report blocked or failed'
  if (review.evidencePaths.length === 0) return 'finalReview requires at least one workspace-relative evidence locator'
  return undefined
}
