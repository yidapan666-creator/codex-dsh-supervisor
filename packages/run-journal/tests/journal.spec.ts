import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { FileRunJournal, runRecordId, type RunRecord } from '../src/index.js'

function record(): RunRecord {
  const sessionId = 'session-1'
  const runId = '11111111-1111-4111-8111-111111111111'
  return {
    schemaVersion: 1, recordId: runRecordId(sessionId, runId), recordedAt: '2026-08-26T00:00:00.000Z',
    sessionId, runId, hostInstanceId: 'host-1', objective: 'ship it', outcome: 'COMPLETED',
    stage: 'done', summary: 'Implemented and verified.', workerState: 'IDLE', files: ['src/a.ts'],
    verification: [{ command: 'pnpm test', outcome: 'passed', summary: 'ok' }], decisions: [], artifacts: [],
    truncation: { files: false, verification: false },
    provenance: { boundarySeq: 12, asOfSeq: 12, generatedBy: 'dsh-gate-runtime', completionProtocolVerified: true, modelCallsUsed: 0 },
  }
}

describe('file run journal', () => {
  it('atomically records one stable entry per run without model work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-run-journal-'))
    const journal = new FileRunJournal(directory)
    expect(await journal.record(record())).toMatchObject({ created: true })
    expect(await journal.record({ ...record(), summary: 'A later duplicate wait.' })).toMatchObject({ created: false })
    expect(await journal.get(record().runId)).toMatchObject({ summary: 'Implemented and verified.', provenance: { modelCallsUsed: 0 } })
    expect(await journal.list()).toHaveLength(1)
    expect((await readFile(join(directory, `${record().recordId}.json`), 'utf8'))).toContain('"modelCallsUsed": 0')
  })

  it('rejects a record whose identity hash was forged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-run-journal-'))
    await expect(new FileRunJournal(directory).record({ ...record(), recordId: 'wrong' })).rejects.toThrow(/identity/)
  })
})
