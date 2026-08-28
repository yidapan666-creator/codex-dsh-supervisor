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

  it('publishes exactly one winner under concurrent terminal writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-run-journal-'))
    const journal = new FileRunJournal(directory)

    const results = await Promise.all(Array.from({ length: 16 }, () => journal.record(record())))

    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(results.every(result => result.recordId === record().recordId)).toBe(true)
    expect(await journal.list()).toHaveLength(1)
  })

  it('bounds retention and reads records through opaque cursor pages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-run-journal-'))
    const journal = new FileRunJournal(directory, {
      maxRecords: 2, maxAgeMs: 60_000, maxBytes: 1_000_000,
    })
    for (let index = 0; index < 3; index++) {
      const sessionId = `session-${index}`
      const runId = `11111111-1111-4111-8111-11111111111${index}`
      await journal.record({
        ...record(), sessionId, runId, recordId: runRecordId(sessionId, runId),
        recordedAt: `2026-08-26T00:00:0${index}.000Z`,
      })
      await new Promise(resolve => setTimeout(resolve, 2))
    }

    expect(await journal.list()).toHaveLength(2)
    const first = await journal.page({ limit: 1 })
    expect(first.records).toHaveLength(1)
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = await journal.page({ limit: 1, cursor: first.nextCursor })
    expect(second.records).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
  })
})
