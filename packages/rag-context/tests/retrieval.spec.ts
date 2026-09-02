import { describe, expect, it } from 'vitest'
import {
  InMemoryLexicalRetriever, lexicalTerms, reciprocalRankFusion, type RagChunk, type RankedCandidate,
  runRecordToRagChunks,
} from '../src/index.js'
import { runRecordId, type RunRecord } from '@dsh-gate/run-journal'

const chunks: RagChunk[] = [
  {
    id: 'gateway', contentHash: 'a',
    text: 'Wait for a material supervisor boundary and reconcile the host snapshot.',
    source: { uri: 'repo://packages/mcp-server/src/gateway.ts#L400', path: 'packages/mcp-server/src/gateway.ts', symbol: 'GatewayManager.wait', language: 'typescript', commit: 'abc' },
  },
  {
    id: 'artifacts', contentHash: 'b',
    text: 'Resolve artifact paths and reject traversal outside the session cwd.',
    source: { uri: 'repo://packages/dsh-supervisor-tools/src/artifacts.ts#L1', path: 'packages/dsh-supervisor-tools/src/artifacts.ts', symbol: 'admitArtifacts', language: 'typescript', commit: 'abc' },
  },
  {
    id: 'docs', contentHash: 'c',
    text: 'The public documentation explains durable reconnect behavior.',
    source: { uri: 'repo://README.md#L1', path: 'README.md', language: 'markdown', commit: 'def' },
  },
]

describe('standalone RAG context primitives', () => {
  it('splits code identifiers while retaining the full identifier', () => {
    expect(lexicalTerms('GatewayManager.wait_andRetry')).toEqual(expect.arrayContaining([
      'gateway', 'manager.wait_and', 'manager', 'wait', 'and', 'retry',
    ]))
  })

  it('ranks identifier-aware lexical matches with reproducible provenance', async () => {
    const result = await new InMemoryLexicalRetriever('commit-abc', chunks).retrieve({ text: 'GatewayManager wait' })
    expect(result.indexVersion).toBe('commit-abc')
    expect(result.hits[0]).toMatchObject({
      chunk: { id: 'gateway', source: { commit: 'abc', symbol: 'GatewayManager.wait' } },
      rank: 1, channel: 'lexical',
    })
    expect(result.hits[0]?.reasons.length).toBeGreaterThan(0)
  })

  it('applies source filters and a hard context budget', async () => {
    const retriever = new InMemoryLexicalRetriever('v1', chunks)
    const filtered = await retriever.retrieve({ text: 'documentation', filters: { commit: 'def', language: 'markdown' } })
    expect(filtered.hits.map(hit => hit.chunk.id)).toEqual(['docs'])
    expect((await retriever.retrieve({ text: 'supervisor', tokenBudget: 1 })).hits).toEqual([])
  })

  it('fuses rankings by rank rather than incomparable channel scores', () => {
    const candidate = (id: string, score: number, channel: string): RankedCandidate => ({
      id, score, channel, chunk: chunks.find(chunk => chunk.id === id)!,
    })
    const fused = reciprocalRankFusion([
      [candidate('gateway', 100, 'lexical'), candidate('artifacts', 10, 'lexical')],
      [candidate('artifacts', 0.9, 'semantic'), candidate('gateway', 0.8, 'semantic')],
      [candidate('artifacts', 5, 'symbol')],
    ])
    expect(fused[0]).toMatchObject({ id: 'artifacts', channel: 'fused' })
    expect(fused[0]?.reasons).toEqual(expect.arrayContaining(['rrf:lexical', 'rrf:semantic', 'rrf:symbol']))
  })

  it('turns a runtime run record into searchable, cited chunks without generation', async () => {
    const record: RunRecord = {
      schemaVersion: 1, recordId: runRecordId('s1', 'r1'), recordedAt: '2026-08-26T00:00:00.000Z',
      sessionId: 's1', runId: 'r1', hostInstanceId: 'h1', objective: 'repair artifact containment',
      outcome: 'COMPLETED', stage: 'done', summary: 'Rejected paths outside cwd.', workerState: 'IDLE',
      files: ['src/artifacts.ts'], verification: [], decisions: [], artifacts: [],
      truncation: { files: false, verification: false },
      provenance: { boundarySeq: 9, asOfSeq: 9, generatedBy: 'dsh-gate-runtime', completionProtocolVerified: true, modelCallsUsed: 0 },
    }
    const chunks = runRecordToRagChunks(record)
    const result = await new InMemoryLexicalRetriever('runs.v1', chunks).retrieve({ text: 'artifact containment cwd' })
    expect(result.hits[0]?.chunk.source.uri).toBe('dsh-run://r1/overview')
  })
})
