import { randomUUID, createHash } from 'node:crypto'
import { link, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
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
  shadow?: {
    policyVersion: string
    timing: string
    audience: string
    action: string
    reasonCode: string
    matchedRuleId: string
    differs: boolean
  }
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
  budget?: {
    limitTokens: number
    observedTokens: number
    remainingTokens: number
    exhausted: boolean
    coverage: 'root_session' | 'run_tree'
    enforcement: 'DSH_HOST_RUNTIME'
  }
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
  page?(options?: RunJournalPageOptions): Promise<RunJournalPage>
}

export interface RunJournalPageOptions {
  /** Opaque filename cursor returned by the previous page. */
  cursor?: string
  limit?: number
}

export interface RunJournalPage {
  records: RunRecord[]
  nextCursor?: string
}

export interface FileRunJournalOptions {
  maxRecords?: number
  maxAgeMs?: number
  maxBytes?: number
}

export const DEFAULT_RUN_JOURNAL_MAX_RECORDS = 10_000
export const DEFAULT_RUN_JOURNAL_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1_000
export const DEFAULT_RUN_JOURNAL_MAX_BYTES = 256 * 1024 * 1024
export const DEFAULT_RUN_JOURNAL_PAGE_SIZE = 100

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
  readonly limits: Required<FileRunJournalOptions>

  constructor(readonly directory: string, options: FileRunJournalOptions = {}) {
    this.limits = {
      maxRecords: options.maxRecords ?? DEFAULT_RUN_JOURNAL_MAX_RECORDS,
      maxAgeMs: options.maxAgeMs ?? DEFAULT_RUN_JOURNAL_MAX_AGE_MS,
      maxBytes: options.maxBytes ?? DEFAULT_RUN_JOURNAL_MAX_BYTES,
    }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
    }
  }

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
      try {
        // Publishing a hard link is atomic and, unlike rename(), never
        // overwrites a winner from another terminal wait/process.
        await link(temporary, target)
      } catch (error) {
        const code = error instanceof Error && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined
        if (code !== 'EEXIST') throw error
        const winner = await readFile(target, 'utf8').then(parseRecord)
        if (winner === undefined) throw new Error('existing run journal record is malformed')
        return { recordId: winner.recordId, created: false }
      }
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    await this.prune()
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
    return (await this.page({ limit: this.limits.maxRecords })).records
  }

  async page(options: RunJournalPageOptions = {}): Promise<RunJournalPage> {
    const limit = options.limit ?? DEFAULT_RUN_JOURNAL_PAGE_SIZE
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > this.limits.maxRecords) {
      throw new Error(`journal page limit must be between 1 and ${this.limits.maxRecords}`)
    }
    const names = (await readdir(this.directory).catch(() => []))
      .filter(name => name.endsWith('.json')).sort()
    const cursor = options.cursor
    const start = cursor === undefined
      ? 0
      : names.findIndex(name => name > cursor)
    if (start < 0) return { records: [] }
    const selected = names.slice(start, start + limit)
    const values = await Promise.all(selected.map(async name =>
      readFile(join(this.directory, name), 'utf8').then(parseRecord).catch(() => undefined)))
    const records = values.filter((record): record is RunRecord => record !== undefined)
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.recordId.localeCompare(right.recordId))
    const last = selected.at(-1)
    return {
      records,
      ...last !== undefined && start + selected.length < names.length ? { nextCursor: last } : {},
    }
  }

  private async prune(now = Date.now()): Promise<void> {
    const names = (await readdir(this.directory).catch(() => [])).filter(name => name.endsWith('.json'))
    const entries = (await Promise.all(names.map(async name => {
      const metadata = await stat(join(this.directory, name)).catch(() => undefined)
      return metadata === undefined ? undefined : { name, mtimeMs: metadata.mtimeMs, bytes: metadata.size }
    }))).filter((entry): entry is { name: string; mtimeMs: number; bytes: number } => entry !== undefined)
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name))
    let bytes = entries.reduce((total, entry) => total + entry.bytes, 0)
    let count = entries.length
    for (const entry of entries) {
      const expired = now - entry.mtimeMs > this.limits.maxAgeMs
      const overCount = count > this.limits.maxRecords
      const overBytes = bytes > this.limits.maxBytes
      if (!expired && !overCount && !overBytes) continue
      await unlink(join(this.directory, entry.name)).catch(error => {
        if (error?.code !== 'ENOENT') throw error
      })
      count--
      bytes -= entry.bytes
    }
  }
}
