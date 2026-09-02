import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface DurableBudgetReservation {
  schemaVersion: 1
  rootSessionId: string
  runId: string
  requestSessionId: string
  turn: number
  step: number
  inputTokens: number
  outputTokens: number
  createdAt: number
}

export interface BudgetReservationLedger {
  list(rootSessionId: string, runId: string): Promise<DurableBudgetReservation[]>
  reserve(reservation: DurableBudgetReservation): Promise<void>
  settle(reservation: DurableBudgetReservation): Promise<void>
}

function reservationIdentity(value: DurableBudgetReservation): string {
  return [value.rootSessionId, value.runId, value.requestSessionId, value.turn, value.step].join('\u0000')
}

function reservationFileName(value: DurableBudgetReservation): string {
  return `${createHash('sha256').update(reservationIdentity(value)).digest('hex')}.json`
}

function isSafeInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function parseReservation(text: string): DurableBudgetReservation {
  const value = JSON.parse(text) as Record<string, unknown>
  if (value.schemaVersion !== 1
    || typeof value.rootSessionId !== 'string' || value.rootSessionId.length === 0
    || typeof value.runId !== 'string' || value.runId.length === 0
    || typeof value.requestSessionId !== 'string' || value.requestSessionId.length === 0
    || !isSafeInteger(value.turn, 1)
    || !isSafeInteger(value.step, 1)
    || !isSafeInteger(value.inputTokens, 0)
    || !isSafeInteger(value.outputTokens, 1)
    || !isSafeInteger(value.createdAt, 0)) {
    throw new Error('invalid durable token reservation record')
  }
  return value as unknown as DurableBudgetReservation
}

function sameReservation(left: DurableBudgetReservation, right: DurableBudgetReservation): boolean {
  return reservationIdentity(left) === reservationIdentity(right)
    && left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function defaultBudgetReservationDirectory(): string {
  const configured = process.env.DSH_GATE_RESERVATION_DIR?.trim()
  if (configured !== undefined && configured.length > 0) return resolve(configured)
  const dshHome = process.env.DSH_HOME?.trim()
  return resolve(dshHome !== undefined && dshHome.length > 0 ? dshHome : join(homedir(), '.dsh'),
    'dsh-gate', 'token-reservations')
}

/** One crash-durable file per in-flight request; no shared mutable index. */
export class FileBudgetReservationLedger implements BudgetReservationLedger {
  readonly directory: string

  constructor(directory = defaultBudgetReservationDirectory()) {
    this.directory = resolve(directory)
  }

  async list(rootSessionId: string, runId: string): Promise<DurableBudgetReservation[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const names = await readdir(this.directory)
    const reservations: DurableBudgetReservation[] = []
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue
      const value = parseReservation(await readFile(join(this.directory, name), 'utf8'))
      if (reservationFileName(value) !== name) throw new Error(`token reservation identity mismatch in ${name}`)
      if (value.rootSessionId === rootSessionId && value.runId === runId) reservations.push(value)
    }
    return reservations
  }

  async reserve(reservation: DurableBudgetReservation): Promise<void> {
    const value = parseReservation(JSON.stringify(reservation))
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = join(this.directory, reservationFileName(value))
    const temporary = join(this.directory, `.reservation-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    await handle.close()
    try {
      await link(temporary, path)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const existing = parseReservation(await readFile(path, 'utf8'))
      if (!sameReservation(existing, value)) throw new Error('conflicting durable token reservation identity')
    } finally {
      await unlink(temporary).catch(() => undefined)
      await syncDirectory(this.directory)
    }
  }

  async settle(reservation: DurableBudgetReservation): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      await unlink(join(this.directory, reservationFileName(reservation)))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      return
    }
    await syncDirectory(this.directory)
  }
}

/** Deterministic test double with the same identity/conflict semantics. */
export class MemoryBudgetReservationLedger implements BudgetReservationLedger {
  private readonly records = new Map<string, DurableBudgetReservation>()

  list(rootSessionId: string, runId: string): Promise<DurableBudgetReservation[]> {
    return Promise.resolve([...this.records.values()]
      .filter(value => value.rootSessionId === rootSessionId && value.runId === runId)
      .map(value => ({ ...value })))
  }

  reserve(reservation: DurableBudgetReservation): Promise<void> {
    const key = reservationIdentity(reservation)
    const current = this.records.get(key)
    if (current !== undefined && !sameReservation(current, reservation)) {
      return Promise.reject(new Error('conflicting durable token reservation identity'))
    }
    this.records.set(key, { ...reservation })
    return Promise.resolve()
  }

  settle(reservation: DurableBudgetReservation): Promise<void> {
    this.records.delete(reservationIdentity(reservation))
    return Promise.resolve()
  }
}
