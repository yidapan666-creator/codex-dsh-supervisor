import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readlink, realpath, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

interface DirtyFingerprint {
  path: string
  fingerprint: string
}

export interface GitBaselineRecord {
  schemaVersion: 1
  sessionId: string
  runId: string
  cwd: string
  gitRoot: string
  head: string
  allowedPrefixes: string[]
  dirty: DirtyFingerprint[]
  createdAt: number
}

export interface GitBaselineVerification {
  headBefore: string
  headAfter: string
  changedPaths: string[]
  outOfScopePaths: string[]
}

export interface GitBaselineStore {
  capture(input: { sessionId: string; runId: string; cwd: string; allowedScope?: unknown }): Promise<GitBaselineRecord>
  verify(input: { sessionId: string; runId: string; cwd: string }): Promise<GitBaselineVerification>
}

function baselineFileName(sessionId: string, runId: string): string {
  return `${createHash('sha256').update(`${sessionId}\u0000${runId}`).digest('hex')}.json`
}

function git(cwd: string, args: string[], encoding: BufferEncoding | 'buffer' = 'utf8'): Promise<string | Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: encoding === 'buffer' ? 'buffer' : encoding,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args[0] ?? 'command'} failed: ${String(stderr).trim() || error.message}`))
        return
      }
      resolvePromise(stdout)
    })
  })
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return String(await git(cwd, args)).trim()
}

async function gitPaths(cwd: string, args: string[]): Promise<string[]> {
  const output = await git(cwd, args, 'buffer') as Buffer
  return output.toString('utf8').split('\u0000').filter(path => path.length > 0)
}

async function dirtyPaths(gitRoot: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    gitPaths(gitRoot, ['diff', '--name-only', '-z', 'HEAD', '--']),
    gitPaths(gitRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--']),
  ])
  return [...new Set([...tracked, ...untracked])].sort()
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => { hash.update(chunk) })
    stream.on('error', reject)
    stream.on('end', resolvePromise)
  })
  return hash.digest('hex')
}

async function pathFingerprint(gitRoot: string, path: string): Promise<string> {
  const absolute = join(gitRoot, ...path.split('/'))
  try {
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) return `symlink:${createHash('sha256').update(await readlink(absolute)).digest('hex')}`
    if (info.isFile()) return `file:${await hashFile(absolute)}`
    if (info.isDirectory()) {
      const head = await gitText(absolute, ['rev-parse', 'HEAD']).catch(() => 'not-a-repository')
      const status = await git(absolute, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'buffer')
        .catch(() => Buffer.from('not-a-repository')) as Buffer
      return `directory:${head}:${createHash('sha256').update(status).digest('hex')}`
    }
    return `other:${info.mode}:${info.size}`
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing'
    throw error
  }
}

function pathFromGitRoot(gitRoot: string, cwd: string): string {
  const value = relative(gitRoot, cwd).split(sep).join('/')
  if (value === '') return ''
  if (value === '..' || value.startsWith('../') || isAbsolute(value)) throw new Error('session cwd is outside its Git worktree')
  return value
}

function normalizeAllowedScope(cwdPrefix: string, value: unknown): string[] {
  if (value === undefined) return [cwdPrefix]
  if (!Array.isArray(value) || value.length === 0 || value.some(entry => typeof entry !== 'string')) {
    throw new Error('writer allowedScope must be a non-empty array of workspace-relative path prefixes')
  }
  return [...new Set(value.map((entry) => {
    const raw = (entry as string).trim().replaceAll('\\', '/')
    if (raw === '' || raw.includes('\u0000') || posix.isAbsolute(raw)) {
      throw new Error(`invalid writer allowedScope path: ${JSON.stringify(entry)}`)
    }
    const normalized = posix.normalize(raw)
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`writer allowedScope escapes the session cwd: ${JSON.stringify(entry)}`)
    }
    const relativePrefix = normalized === '.' ? '' : normalized.replace(/^\.\//, '').replace(/\/$/, '')
    return [cwdPrefix, relativePrefix].filter(Boolean).join('/')
  }))].sort()
}

function within(path: string, prefix: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`)
}

function parseRecord(text: string): GitBaselineRecord {
  const value = JSON.parse(text) as GitBaselineRecord
  if (value.schemaVersion !== 1 || typeof value.sessionId !== 'string' || typeof value.runId !== 'string'
    || typeof value.cwd !== 'string' || typeof value.gitRoot !== 'string' || typeof value.head !== 'string'
    || !Array.isArray(value.allowedPrefixes) || value.allowedPrefixes.some(prefix => typeof prefix !== 'string')
    || !Array.isArray(value.dirty) || value.dirty.some(entry => typeof entry !== 'object' || entry === null
      || typeof entry.path !== 'string' || typeof entry.fingerprint !== 'string')
    || !Number.isSafeInteger(value.createdAt)) throw new Error('invalid Git baseline record')
  return value
}

function sameCaptureIdentity(
  record: GitBaselineRecord,
  identity: { sessionId: string; runId: string; cwd: string; gitRoot: string; allowedPrefixes: readonly string[] },
): boolean {
  return record.sessionId === identity.sessionId && record.runId === identity.runId
    && record.cwd === identity.cwd && record.gitRoot === identity.gitRoot
    && record.allowedPrefixes.length === identity.allowedPrefixes.length
    && record.allowedPrefixes.every((prefix, index) => prefix === identity.allowedPrefixes[index])
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function defaultGitBaselineDirectory(): string {
  const configured = process.env.DSH_GATE_GIT_BASELINE_DIR?.trim()
  if (configured !== undefined && configured.length > 0) return resolve(configured)
  const dshHome = process.env.DSH_HOME?.trim()
  return resolve(dshHome !== undefined && dshHome.length > 0 ? dshHome : join(homedir(), '.dsh'),
    'dsh-gate', 'git-baselines')
}

export class FileGitBaselineStore implements GitBaselineStore {
  readonly directory: string

  constructor(directory = defaultGitBaselineDirectory()) {
    this.directory = resolve(directory)
  }

  private async read(sessionId: string, runId: string): Promise<GitBaselineRecord | undefined> {
    try {
      return parseRecord(await readFile(join(this.directory, baselineFileName(sessionId, runId)), 'utf8'))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  async capture(input: { sessionId: string; runId: string; cwd: string; allowedScope?: unknown }): Promise<GitBaselineRecord> {
    const cwd = await realpath(input.cwd)
    const gitRoot = await realpath(await gitText(cwd, ['rev-parse', '--show-toplevel']))
    const allowedPrefixes = normalizeAllowedScope(pathFromGitRoot(gitRoot, cwd), input.allowedScope)
    const identity = { sessionId: input.sessionId, runId: input.runId, cwd, gitRoot, allowedPrefixes }
    const existing = await this.read(input.sessionId, input.runId)
    if (existing !== undefined) {
      if (!sameCaptureIdentity(existing, identity)) throw new Error('Git baseline identity changed across admission retry')
      return existing
    }
    const head = await gitText(gitRoot, ['rev-parse', 'HEAD'])
    const paths = await dirtyPaths(gitRoot)
    const dirty = await Promise.all(paths.map(async path => ({ path, fingerprint: await pathFingerprint(gitRoot, path) })))
    const record: GitBaselineRecord = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      runId: input.runId,
      cwd,
      gitRoot,
      head,
      allowedPrefixes,
      dirty,
      createdAt: Date.now(),
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = join(this.directory, `.baseline-${randomUUID()}.tmp`)
    const final = join(this.directory, baselineFileName(input.sessionId, input.runId))
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporary, final)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const raced = await this.read(input.sessionId, input.runId)
      if (raced === undefined || !sameCaptureIdentity(raced, identity)) throw new Error('conflicting Git baseline identity')
      return raced
    } finally {
      await unlink(temporary).catch(() => undefined)
      await syncDirectory(this.directory)
    }
    return record
  }

  async verify(input: { sessionId: string; runId: string; cwd: string }): Promise<GitBaselineVerification> {
    const baseline = await this.read(input.sessionId, input.runId)
    if (baseline === undefined) throw new Error(`missing Host Git baseline for run ${input.runId}`)
    if (baseline.sessionId !== input.sessionId || baseline.runId !== input.runId) {
      throw new Error('Host Git baseline record identity does not match its durable key')
    }
    if (baseline.cwd !== await realpath(input.cwd)) throw new Error('session cwd no longer matches its Host Git baseline')
    const headAfter = await gitText(baseline.gitRoot, ['rev-parse', 'HEAD'])
    const currentDirty = await dirtyPaths(baseline.gitRoot)
    const committed = headAfter === baseline.head
      ? []
      : await gitPaths(baseline.gitRoot, ['diff', '--name-only', '-z', `${baseline.head}..${headAfter}`, '--'])
    const baselineDirty = new Map(baseline.dirty.map(entry => [entry.path, entry.fingerprint]))
    const candidates = [...new Set([...baselineDirty.keys(), ...currentDirty, ...committed])].sort()
    const changedPaths: string[] = []
    for (const path of candidates) {
      if (committed.includes(path) || !baselineDirty.has(path)) {
        changedPaths.push(path)
        continue
      }
      if (await pathFingerprint(baseline.gitRoot, path) !== baselineDirty.get(path)) changedPaths.push(path)
    }
    const outOfScopePaths = changedPaths.filter(path => !baseline.allowedPrefixes.some(prefix => within(path, prefix)))
    return { headBefore: baseline.head, headAfter, changedPaths, outOfScopePaths }
  }
}
