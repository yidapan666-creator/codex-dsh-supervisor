import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RUN_RECORD_OUTCOMES = [
  'COMPLETED', 'BLOCKED', 'MAJOR_CHECKPOINT', 'FAILED', 'ESCALATION_REQUIRED',
] as const
export type RunRecordOutcome = typeof RUN_RECORD_OUTCOMES[number]

export interface RunDecisionRecord {
  category: string
  impact: string
  blocking: boolean
  request: string
  timing: string
  audience: string
  action: string
  reasonCode: string
  handled: boolean
}

export interface RunRecord {
  schemaVersion: 1
  recordId: string
  recordedAt: string
  sessionId: string
  runId: string
  hostInstanceId: string
  objective: string
  outcome: RunRecordOutcome
  stage: string
  summary: string
  workerState: string
  baseline?: { head?: string; statusSummary: string }
  files: string[]
  verification: Array<{ command: string; outcome: string; summary: string }>
  decisions: RunDecisionRecord[]
  failure?: { kind: string; message: string; retryable: boolean }
  projectActivity?: unknown
  artifacts: Array<{ path: string; bytes: number; sha256: string }>
  truncation: { files: boolean; verification: boolean }
  provenance: {
    boundarySeq: number
    asOfSeq: number
    generatedBy: 'dsh-gate-runtime'
    completionProtocolVerified: boolean
    modelCallsUsed: 0
  }
}

export interface RunJournalWriteResult {
  recordId: string
  created: boolean
}

export interface RunJournal {
  record(value: RunRecord): Promise<RunJournalWriteResult>
  get(runId: string): Promise<RunRecord | undefined>
  list(): Promise<RunRecord[]>
}

export function isRunRecordOutcome(value: string): value is RunRecordOutcome {
  return (RUN_RECORD_OUTCOMES as readonly string[]).includes(value)
}

export function runRecordId(sessionId: string, runId: string): string {
  return createHash('sha256').update(`${sessionId}\0${runId}`).digest('hex')
}

function parseRecord(text: string): RunRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<RunRecord>
    return value.schemaVersion === 1 && typeof value.runId === 'string' && typeof value.recordId === 'string'
      ? value as RunRecord
      : undefined
  } catch { return undefined }
}

/** One atomic, idempotently addressed JSON record per supervised run. */
export class FileRunJournal implements RunJournal {
  constructor(readonly directory: string) {}

  private pathFor(runId: string, sessionId?: string): string {
    const name = sessionId === undefined
      ? createHash('sha256').update(runId).digest('hex')
      : runRecordId(sessionId, runId)
    return join(this.directory, `${name}.json`)
  }

  async record(value: RunRecord): Promise<RunJournalWriteResult> {
    if (value.recordId !== runRecordId(value.sessionId, value.runId)) throw new Error('run record id does not match its identity')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const target = this.pathFor(value.runId, value.sessionId)
    const existing = await readFile(target, 'utf8').then(parseRecord).catch(() => undefined)
    if (existing !== undefined) return { recordId: existing.recordId, created: false }
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, target)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    return { recordId: value.recordId, created: true }
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const names = await readdir(this.directory).catch(() => [])
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const value = await readFile(join(this.directory, name), 'utf8').then(parseRecord).catch(() => undefined)
      if (value?.runId === runId) return value
    }
    return undefined
  }

  async list(): Promise<RunRecord[]> {
    const names = await readdir(this.directory).catch(() => [])
    const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name =>
      readFile(join(this.directory, name), 'utf8').then(parseRecord).catch(() => undefined)))
    return records.filter((record): record is RunRecord => record !== undefined)
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.recordId.localeCompare(right.recordId))
  }
}
