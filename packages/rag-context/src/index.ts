export interface RagSource {
  uri: string
  path?: string
  commit?: string
  language?: string
  symbol?: string
  startLine?: number
  endLine?: number
}

export interface RagChunk {
  id: string
  text: string
  contentHash: string
  source: RagSource
}

export interface RagQuery {
  text: string
  limit?: number
  tokenBudget?: number
  filters?: {
    pathPrefix?: string
    commit?: string
    language?: string
  }
}

export interface RagHit {
  chunk: RagChunk
  score: number
  rank: number
  channel: string
  reasons: string[]
}

export interface RetrievalResult {
  query: string
  indexVersion: string
  hits: RagHit[]
}

export interface Retriever {
  retrieve(query: RagQuery): Promise<RetrievalResult>
}

export interface MutableIndex {
  upsert(chunks: readonly RagChunk[]): void
  remove(ids: readonly string[]): void
  clear(): void
}

export interface RankedCandidate {
  id: string
  score: number
  chunk: RagChunk
  channel: string
  reasons?: string[]
}

const MAX_LIMIT = 100

/** Tokenize prose and code while retaining both full identifiers and their parts. */
export function lexicalTerms(text: string): string[] {
  const normalized = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^\p{L}\p{N}_./:-]+/gu, ' ')
    .toLowerCase()
  const terms: string[] = []
  for (const raw of normalized.split(/\s+/).filter(Boolean)) {
    terms.push(raw)
    for (const part of raw.split(/[_./:-]+/).filter(Boolean)) {
      if (part !== raw) terms.push(part)
    }
  }
  return terms
}

function termFrequency(terms: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1)
  return counts
}

function estimatedTokens(text: string): number {
  return Math.max(1, lexicalTerms(text).length)
}

function matchesFilters(chunk: RagChunk, filters: RagQuery['filters']): boolean {
  if (filters === undefined) return true
  return (filters.commit === undefined || chunk.source.commit === filters.commit)
    && (filters.language === undefined || chunk.source.language === filters.language)
    && (filters.pathPrefix === undefined || chunk.source.path === filters.pathPrefix
      || chunk.source.path?.startsWith(filters.pathPrefix.endsWith('/') ? filters.pathPrefix : `${filters.pathPrefix}/`) === true)
}

/**
 * Deterministic in-memory BM25 baseline. It is intentionally dependency-free:
 * future semantic/vector implementations plug in through Retriever instead of
 * changing callers or coupling this package to the supervision runtime.
 */
export class InMemoryLexicalRetriever implements Retriever, MutableIndex {
  private readonly chunks = new Map<string, RagChunk>()

  constructor(private readonly indexVersion = 'memory.v1', chunks: readonly RagChunk[] = []) {
    this.upsert(chunks)
  }

  upsert(chunks: readonly RagChunk[]): void {
    for (const chunk of chunks) {
      if (chunk.id.trim() === '' || chunk.text.trim() === '' || chunk.contentHash.trim() === '' || chunk.source.uri.trim() === '') {
        throw new Error('RAG chunks require non-empty id, text, contentHash, and source.uri')
      }
      if (chunk.source.startLine !== undefined && (!Number.isSafeInteger(chunk.source.startLine) || chunk.source.startLine < 1)) {
        throw new Error('RAG chunk startLine must be a positive integer')
      }
      if (chunk.source.endLine !== undefined && (!Number.isSafeInteger(chunk.source.endLine)
        || chunk.source.endLine < (chunk.source.startLine ?? 1))) {
        throw new Error('RAG chunk endLine must be at or after startLine')
      }
      this.chunks.set(chunk.id, chunk)
    }
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) this.chunks.delete(id)
  }

  clear(): void { this.chunks.clear() }

  async retrieve(query: RagQuery): Promise<RetrievalResult> {
    const queryTerms = lexicalTerms(query.text)
    if (queryTerms.length === 0) return { query: query.text, indexVersion: this.indexVersion, hits: [] }
    const candidates = [...this.chunks.values()].filter(chunk => matchesFilters(chunk, query.filters))
    if (candidates.length === 0) return { query: query.text, indexVersion: this.indexVersion, hits: [] }
    const docs = candidates.map(chunk => ({
      chunk,
      terms: lexicalTerms(`${chunk.source.path ?? ''} ${chunk.source.symbol ?? ''} ${chunk.text}`),
    }))
    const averageLength = docs.reduce((sum, doc) => sum + doc.terms.length, 0) / docs.length
    const documentFrequency = new Map<string, number>()
    for (const doc of docs) {
      for (const term of new Set(doc.terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
    const uniqueQueryTerms = [...new Set(queryTerms)]
    const ranked = docs.flatMap(({ chunk, terms }): RankedCandidate[] => {
      const frequencies = termFrequency(terms)
      let score = 0
      const matched: string[] = []
      for (const term of uniqueQueryTerms) {
        const frequency = frequencies.get(term) ?? 0
        if (frequency === 0) continue
        matched.push(term)
        const frequencyInDocs = documentFrequency.get(term) ?? 0
        const inverseFrequency = Math.log(1 + ((docs.length - frequencyInDocs + 0.5) / (frequencyInDocs + 0.5)))
        const denominator = frequency + 1.2 * (0.25 + 0.75 * terms.length / Math.max(averageLength, 1))
        score += inverseFrequency * ((frequency * 2.2) / denominator)
      }
      const lowerQuery = query.text.trim().toLowerCase()
      const identifier = `${chunk.source.path ?? ''} ${chunk.source.symbol ?? ''}`.toLowerCase()
      if (lowerQuery !== '' && identifier.includes(lowerQuery)) score += 2
      return score === 0 ? [] : [{
        id: chunk.id,
        score,
        chunk,
        channel: 'lexical',
        reasons: matched.slice(0, 8).map(term => `term:${term}`),
      }]
    }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))

    const limit = Math.min(Math.max(query.limit ?? 10, 0), MAX_LIMIT)
    const budget = query.tokenBudget ?? Number.POSITIVE_INFINITY
    const hits: RagHit[] = []
    let consumed = 0
    for (const candidate of ranked) {
      if (hits.length >= limit) break
      const cost = estimatedTokens(candidate.chunk.text)
      if (consumed + cost > budget) continue
      consumed += cost
      hits.push({
        chunk: candidate.chunk,
        score: candidate.score,
        rank: hits.length + 1,
        channel: candidate.channel,
        reasons: candidate.reasons ?? [],
      })
    }
    return { query: query.text, indexVersion: this.indexVersion, hits }
  }
}

/** Fuse independent rankings without assuming their raw scores are comparable. */
export function reciprocalRankFusion(
  rankings: readonly (readonly RankedCandidate[])[],
  options: { k?: number; limit?: number } = {},
): RankedCandidate[] {
  const k = options.k ?? 60
  if (!Number.isFinite(k) || k < 0) throw new Error('RRF k must be a non-negative number')
  const fused = new Map<string, RankedCandidate>()
  rankings.forEach((ranking) => {
    const seen = new Set<string>()
    ranking.forEach((candidate, index) => {
      if (seen.has(candidate.id)) return
      seen.add(candidate.id)
      const contribution = 1 / (k + index + 1)
      const previous = fused.get(candidate.id)
      fused.set(candidate.id, previous === undefined
        ? { ...candidate, score: contribution, channel: 'fused', reasons: [`rrf:${candidate.channel}`] }
        : {
          ...previous,
          score: previous.score + contribution,
          reasons: [...new Set([...(previous.reasons ?? []), `rrf:${candidate.channel}`])],
        })
    })
  })
  const limit = Math.min(Math.max(options.limit ?? 10, 0), MAX_LIMIT)
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit)
}
