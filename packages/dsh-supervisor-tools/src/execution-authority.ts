/** Host-owned execution leases. Worker messages and native question answers are never grants. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { authorizeSupervisorRequest } from './host-auth.js'

export const EXECUTION_CONTRACT = 'execution-lease-v1'
export const EXECUTION_CONTROL_PATH = '/api/dsh-gate.execution-control'
export interface ExecutionState {
  contract: typeof EXECUTION_CONTRACT
  sessionId: string
  runId: string
  generation: number
  mode: 'investigating' | 'granted' | 'paused'
  bootId: string
  phase: string
  expiresAt: number
  remainingEffects: number
  paths: string[]
  opaqueTools: string[]
  reason: string
  independentReview?: { verdict: 'ACCEPTED' | 'REJECTED'; asOfSeq: number; evidence: string; recordedAt: number; source: 'SUPERVISOR_DECLARATION' }
}
export interface ExecutionCommand {
  sessionId: string; runId: string
  action: 'status' | 'grant' | 'renew' | 'pause' | 'revise' | 'record_review'
  verdict?: 'ACCEPTED' | 'REJECTED'
  asOfSeq?: number
  evidence?: string
  expectedGeneration?: number
  phase?: string
  paths?: string[]
  opaqueTools?: string[]
  acknowledgeUnconfinedEffects?: boolean
  leaseMs?: number
  maxEffects?: number
}
export interface ExecutionView extends ExecutionState {
  status: 'INVESTIGATING' | 'GRANTED' | 'PAUSED' | 'EXPIRED' | 'RESTARTED' | 'AWAITING_GRANT'
  waitingEffects: number
  activeEffects: number
  quiescence: 'NO_TRACKED_EFFECTS' | 'EFFECTS_IN_FLIGHT'
  externalEffectConfinement: 'NOT_PROVIDED'
}
export interface ExecutionStore {
  read(sessionId: string, runId: string): Promise<ExecutionState | undefined>
  write(state: ExecutionState): Promise<void>
}
function key(sessionId: string, runId: string): string { return JSON.stringify([sessionId, runId]) }
function validPath(path: string): boolean {
  return path === '.' || (path.length > 0 && path.length <= 4096 && !isAbsolute(path)
    && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part !== '..' && part !== '.' && part !== ''))
}
export function scopeContains(prefix: string, path: string): boolean {
  return prefix === '.' || path === prefix || path.startsWith(`${prefix}/`)
}
function parseState(text: string, sessionId: string, runId: string): ExecutionState {
  const s = JSON.parse(text) as ExecutionState
  if (s.contract !== EXECUTION_CONTRACT || s.sessionId !== sessionId || s.runId !== runId
    || !Number.isSafeInteger(s.generation) || s.generation < 0
    || !['investigating', 'granted', 'paused'].includes(s.mode) || typeof s.bootId !== 'string'
    || typeof s.phase !== 'string' || typeof s.reason !== 'string'
    || !Number.isSafeInteger(s.expiresAt) || s.expiresAt < 0
    || !Number.isSafeInteger(s.remainingEffects) || s.remainingEffects < 0 || s.remainingEffects > 64
    || !Array.isArray(s.paths) || !s.paths.every(p => typeof p === 'string' && validPath(p))
    || !Array.isArray(s.opaqueTools) || !s.opaqueTools.every(p => typeof p === 'string')) throw new Error('corrupt execution authority; fail closed')
  const review = s.independentReview
  if (review !== undefined && (review.source !== 'SUPERVISOR_DECLARATION' || !['ACCEPTED', 'REJECTED'].includes(review.verdict)
    || !Number.isSafeInteger(review.asOfSeq) || review.asOfSeq < 0 || !Number.isSafeInteger(review.recordedAt)
    || typeof review.evidence !== 'string' || review.evidence.length === 0 || review.evidence.length > 1024)) throw new Error('corrupt independent review declaration')
  return s
}
export class FileExecutionStore implements ExecutionStore {
  constructor(readonly directory = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'dsh-gate', 'execution-authority')) {}
  private path(sessionId: string, runId: string): string {
    return join(this.directory, `${createHash('sha256').update(key(sessionId, runId)).digest('hex')}.json`)
  }
  async read(sessionId: string, runId: string): Promise<ExecutionState | undefined> {
    try { return parseState(await readFile(this.path(sessionId, runId), 'utf8'), sessionId, runId) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async write(state: ExecutionState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const target = this.path(state.sessionId, state.runId)
    const temp = `${target}.${randomUUID()}.tmp`
    const file = await open(temp, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(state)); await file.sync() } finally { await file.close() }
    try {
      await rename(temp, target)
      const dir = await open(this.directory, 'r')
      try { await dir.sync() } finally { await dir.close() }
    } finally { await unlink(temp).catch(() => {}) }
  }
}
export class MemoryExecutionStore implements ExecutionStore {
  readonly values = new Map<string, ExecutionState>()
  async read(sessionId: string, runId: string): Promise<ExecutionState | undefined> { return structuredClone(this.values.get(key(sessionId, runId))) }
  async write(state: ExecutionState): Promise<void> { this.values.set(key(state.sessionId, state.runId), structuredClone(state)) }
}

/** One Host instance owns this store. CAS generations make ambiguous control calls safe to reconcile with status. */
export class ExecutionAuthority {
  private readonly states = new Map<string, ExecutionState>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly waiting = new Map<string, number>()
  private readonly active = new Map<symbol, string>()
  private readonly permitted = new Map<symbol, { key: string; generation: number }>()
  private readonly faults = new Set<string>()
  constructor(readonly store: ExecutionStore, readonly now = Date.now, readonly bootId = randomUUID()) {}
  private async serial<T>(sessionId: string, runId: string, fn: () => Promise<T>): Promise<T> {
    const k = key(sessionId, runId)
    const previous = this.locks.get(k) ?? Promise.resolve()
    const promise = previous.catch(() => {}).then(fn)
    this.locks.set(k, promise)
    try { return await promise } finally { if (this.locks.get(k) === promise) this.locks.delete(k) }
  }
  private async load(sessionId: string, runId: string): Promise<ExecutionState> {
    const k = key(sessionId, runId)
    if (this.faults.has(k)) throw new Error('execution authority persistence failed; restart and reconcile')
    let s = this.states.get(k)
    if (s === undefined) {
      s = await this.store.read(sessionId, runId) ?? {
        contract: EXECUTION_CONTRACT, sessionId, runId, generation: 0, mode: 'investigating', bootId: this.bootId,
        phase: '', expiresAt: 0, remainingEffects: 0, paths: [], opaqueTools: [], reason: 'Initial investigation; implementation requires a supervisor grant.',
      }
      this.states.set(k, s)
    }
    return s
  }
  private status(s: ExecutionState): ExecutionView['status'] {
    if (s.bootId !== this.bootId) return 'RESTARTED'
    if (s.mode === 'paused') return 'PAUSED'
    if (s.mode === 'granted' && (s.expiresAt <= this.now() || s.remainingEffects === 0)) return 'EXPIRED'
    if (s.mode === 'granted') return 'GRANTED'
    return (this.waiting.get(key(s.sessionId, s.runId)) ?? 0) > 0 ? 'AWAITING_GRANT' : 'INVESTIGATING'
  }
  private view(s: ExecutionState): ExecutionView {
    const k = key(s.sessionId, s.runId)
    const activeEffects = [...this.active.values()].filter(v => v === k).length
    return { ...structuredClone(s), status: this.status(s), waitingEffects: this.waiting.get(k) ?? 0, activeEffects,
      quiescence: activeEffects === 0 ? 'NO_TRACKED_EFFECTS' : 'EFFECTS_IN_FLIGHT', externalEffectConfinement: 'NOT_PROVIDED' }
  }
  async inspect(sessionId: string, runId: string): Promise<ExecutionView> {
    return this.serial(sessionId, runId, async () => this.view(await this.load(sessionId, runId)))
  }
  private async save(s: ExecutionState): Promise<void> {
    const k = key(s.sessionId, s.runId)
    // Withdraw cached authority before asynchronous persistence; the final native guard fails closed during the write.
    this.states.delete(k)
    this.faults.add(k)
    await this.store.write(s)
    this.states.set(k, s)
    this.faults.delete(k)
    for (const wake of this.listeners.get(k) ?? []) wake()
  }
  async control(c: ExecutionCommand, allowedScope: readonly string[], writer: boolean): Promise<ExecutionView> {
    return this.serial(c.sessionId, c.runId, async () => {
      const s = await this.load(c.sessionId, c.runId)
      if (c.action === 'status') return this.view(s)
      if (c.expectedGeneration !== s.generation) throw new Error('stale execution generation; read status and reconsider, never replay a grant blindly')
      const next = { ...s, generation: s.generation + 1, bootId: this.bootId }
      if (c.action === 'record_review') {
        if (!['ACCEPTED', 'REJECTED'].includes(c.verdict ?? '') || !Number.isSafeInteger(c.asOfSeq) || c.asOfSeq! < 0
          || !c.evidence?.trim() || c.evidence.length > 1024 || this.view(s).activeEffects > 0) throw new Error('invalid independent review declaration or effects still in flight')
        next.mode = 'paused'; next.remainingEffects = 0; next.expiresAt = 0
        next.reason = 'Worker completion independently reviewed at the recorded event boundary.'
        next.independentReview = { verdict: c.verdict!, asOfSeq: c.asOfSeq!, evidence: c.evidence, recordedAt: this.now(), source: 'SUPERVISOR_DECLARATION' }
      } else if (c.action === 'pause' || c.action === 'revise') {
        next.mode = c.action === 'pause' ? 'paused' : 'investigating'
        next.expiresAt = 0; next.remainingEffects = 0; next.paths = []; next.opaqueTools = []
        next.reason = c.action === 'pause' ? 'Supervisor paused new execution.' : 'Supervisor requested revision; investigate and submit a new proposal.'
      } else if (c.action === 'grant' || c.action === 'renew') {
        delete next.independentReview
        if (c.action === 'renew' && this.status(s) !== 'GRANTED') throw new Error('renew requires a live grant; expired/restarted/paused work needs a new reviewed grant')
        const lease = c.leaseMs ?? 600_000
        const count = c.maxEffects ?? 32
        const paths = c.action === 'renew' ? s.paths : c.paths ?? []
        const opaque = c.action === 'renew' ? s.opaqueTools : c.opaqueTools ?? []
        const phase = c.action === 'renew' ? s.phase : c.phase
        if (!phase?.trim() || phase.length > 256 || !Number.isInteger(lease) || lease < 1000 || lease > 600_000
          || !Number.isInteger(count) || count < 1 || count > 64
          || paths.length > 64 || !paths.every(p => typeof p === 'string' && validPath(p) && allowedScope.some(a => scopeContains(a, p)))
          || opaque.length > 16 || !opaque.every(t => ['bash', 'terminal_open', 'terminal_send', 'terminal_signal', 'terminal_close', 'subagent', 'subagent_fork'].includes(t))) throw new Error('invalid or out-of-scope bounded execution grant')
        if (!writer && (paths.length > 0 || opaque.length > 0)) throw new Error('read-only tasks cannot acquire effect authority')
        // Shells and unfamiliar backends cannot enforce a narrower file scope or exclude network/hooks.
        if (opaque.length > 0 && (!allowedScope.includes('.') || (c.action === 'grant' && c.acknowledgeUnconfinedEffects !== true))) {
          throw new Error('opaque tools require full-cwd task scope and explicit acknowledgement of unconfined indirect/external effects under existing user authority')
        }
        Object.assign(next, { mode: 'granted', phase, paths, opaqueTools: opaque, expiresAt: this.now() + lease,
          remainingEffects: count, reason: 'Bounded supervisor phase grant; broader user permissions remain unchanged.' })
      } else throw new Error('unknown execution action')
      await this.save(next)
      return this.view(next)
    })
  }
  /** A proposal withdraws any earlier phase grant before publishing the native question. */
  async proposal(sessionId: string, runId: string): Promise<number> {
    return this.serial(sessionId, runId, async () => {
      const s = await this.load(sessionId, runId)
      const next: ExecutionState = { ...s, generation: s.generation + 1, mode: 'investigating', bootId: this.bootId,
        remainingEffects: 0, expiresAt: 0, paths: [], opaqueTools: [], reason: 'Proposal submitted; supervisor grant required.' }
      // A worker cannot use another proposal to undo an explicit pause/restart/expiry.
      if (['PAUSED', 'RESTARTED', 'EXPIRED'].includes(this.status(s))) return s.generation
      await this.save(next)
      return next.generation
    })
  }
  private async changed(k: string, signal: AbortSignal, generation: number): Promise<void> {
    if (signal.aborted) throw new Error('execution wait aborted')
    await new Promise<void>((resolveWait, reject) => {
      const listeners = this.listeners.get(k) ?? new Set<() => void>()
      this.listeners.set(k, listeners)
      const cleanup = () => { listeners.delete(wake); signal.removeEventListener('abort', abort) }
      const wake = () => { cleanup(); resolveWait() }
      const abort = () => { cleanup(); reject(new Error('execution wait aborted')) }
      listeners.add(wake); signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else if (this.states.get(k)?.generation !== generation) wake()
    })
  }
  async waitProvider(sessionId: string, runId: string, signal: AbortSignal): Promise<void> {
    const k = key(sessionId, runId)
    while (true) {
      const s = await this.inspect(sessionId, runId)
      if (['INVESTIGATING', 'AWAITING_GRANT', 'GRANTED'].includes(s.status)) return
      await this.changed(k, signal, s.generation)
    }
  }
  /** Reserves an effect durably before allowing native execution; waits without invoking a provider. */
  async enter(sessionId: string, runId: string, token: symbol, signal: AbortSignal,
    check: (state: ExecutionState) => Promise<boolean>): Promise<boolean> {
    const k = key(sessionId, runId)
    const initial = (await this.inspect(sessionId, runId)).generation
    this.waiting.set(k, (this.waiting.get(k) ?? 0) + 1)
    try {
      while (!signal.aborted) {
        const result = await this.serial(sessionId, runId, async () => {
          const s = await this.load(sessionId, runId)
          if (s.mode === 'investigating' && s.generation > initial && s.reason.startsWith('Supervisor requested revision')) return { denied: true, generation: s.generation }
          if (this.status(s) !== 'GRANTED') return { generation: s.generation }
          if (!await check(s)) {
            const paused: ExecutionState = { ...s, generation: s.generation + 1, mode: 'paused', expiresAt: 0,
              remainingEffects: 0, reason: 'Attempted effect is outside the granted tool/path capability; supervisor revision required.' }
            await this.save(paused)
            return { generation: paused.generation }
          }
          if (signal.aborted || s.expiresAt <= this.now()) return { denied: true, generation: s.generation }
          // Consumption is conservative after crash/abort; never recycle uncertain allowances.
          const next = { ...s, remainingEffects: s.remainingEffects - 1 }
          await this.save(next)
          this.permitted.set(token, { key: k, generation: s.generation })
          this.active.set(token, k)
          return { admitted: true, generation: s.generation }
        })
        if (result.admitted) return true
        if (result.denied) return false
        await this.changed(k, signal, result.generation)
      }
      return false
    } finally { this.waiting.set(k, Math.max(0, (this.waiting.get(k) ?? 1) - 1)) }
  }
  /** Last synchronous check after any asynchronous approval; pause cannot be overridden by native approval. */
  permits(token: symbol): boolean {
    const p = this.permitted.get(token)
    if (p === undefined || this.faults.has(p.key)) return false
    const s = this.states.get(p.key)
    return s !== undefined && s.generation === p.generation && s.mode === 'granted'
      && s.bootId === this.bootId && s.expiresAt > this.now()
  }
  finish(token: symbol): void { this.active.delete(token); this.permitted.delete(token) }
}

/** Additional guard for known file tools. This is a preflight, not a race-free filesystem sandbox. */
export async function effectCovered(s: ExecutionState, cwd: string | undefined, name: string, raw: unknown): Promise<boolean> {
  const args = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  if (args.sandbox_permissions !== undefined && args.sandbox_permissions !== 'use_default') return false
  if (s.opaqueTools.includes(name)) return true
  if (!['write', 'edit', 'str_replace_editor'].includes(name) || cwd === undefined) return false
  const path = name === 'str_replace_editor' ? args.path : args.file_path
  if (typeof path !== 'string' || !validPath(path) || path === '.' || !s.paths.some(p => scopeContains(p, path))) return false
  const root = await realpath(cwd)
  let cursor = root
  const parts = path.split('/')
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!)
    try {
      const st = await lstat(cursor)
      if (st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) return false
      if (!scopeContains(root, await realpath(cursor))) return false
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; break }
  }
  return true
}

export function registerExecutionRoute(webServer: { register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void },
  execute: (command: ExecutionCommand) => Promise<ExecutionView>): () => void {
  return webServer.register({ kind: 'exact', path: EXECUTION_CONTROL_PATH, async handler(req, res) {
    if (!authorizeSupervisorRequest(req, res)) return
    try {
      if (req.method !== 'POST') throw new Error('POST required')
      let body = ''
      for await (const chunk of req) { body += String(chunk); if (Buffer.byteLength(body) > 32768) throw new Error('execution control body too large') }
      const command = JSON.parse(body) as ExecutionCommand
      if (typeof command.sessionId !== 'string' || command.sessionId.length < 1 || command.sessionId.length > 512
        || typeof command.runId !== 'string' || !/^[0-9a-f-]{36}$/i.test(command.runId)) throw new Error('invalid execution identity')
      const value = await execute(command)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value))
    } catch {
      res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'Execution control rejected. Re-read status; check current identity, generation, scope and capability constraints. Never blindly replay a grant.' }))
    }
  } })
}
