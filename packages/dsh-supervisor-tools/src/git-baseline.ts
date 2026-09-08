import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, readlink, realpath, unlink } from 'node:fs/promises'
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
  verify(input: {
    sessionId: string
    runId: string
    cwd: string
    /** Exact workspace-relative paths already admitted as safe handoff artifacts. */
    admittedHandoffArtifactPaths?: readonly string[]
  }): Promise<GitBaselineVerification>
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

interface ObservablePathSet {
  paths: string[]
  metadataOnly: ReadonlySet<string>
}

async function gitDirtyPaths(gitRoot: string, ignoredExceptions: readonly string[]): Promise<ObservablePathSet> {
  const [tracked, untracked, ignored] = await Promise.all([
    gitPaths(gitRoot, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']),
    gitPaths(gitRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--']),
    gitPaths(gitRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--']),
  ])
  const visibleIgnored = ignored.filter(path => !ignoredExceptions.some(prefix => within(path, prefix)))
  const contentFingerprinted = new Set([...tracked, ...untracked])
  return {
    paths: [...new Set([...tracked, ...untracked, ...visibleIgnored])].sort(),
    // Ignored trees commonly contain dependency/build caches. File metadata is
    // sufficient here because ctime cannot be restored by an unprivileged
    // worker, while avoiding hashing every byte on each verification pass.
    metadataOnly: new Set(visibleIgnored.filter(path => !contentFingerprinted.has(path))),
  }
}

const HANDOFF_TREE_MAX_ENTRIES = 10_000
const HANDOFF_TREE_MAX_BYTES = 256 * 1024 * 1024

/**
 * Enumerate the session handoff tree independently of Git. The repository may
 * intentionally ignore `.dsh-handoff/`; Git status therefore cannot be the
 * security boundary for deciding whether an unlisted artifact was created.
 */
async function handoffTreePaths(gitRoot: string, cwd: string): Promise<string[]> {
  const cwdPrefix = pathFromGitRoot(gitRoot, cwd)
  const rootRelative = [cwdPrefix, '.dsh-handoff'].filter(Boolean).join('/')
  const root = join(cwd, '.dsh-handoff')
  let entries = 0
  let bytes = 0
  const paths: string[] = []

  async function walk(absolute: string, relativePath: string): Promise<void> {
    let info
    try {
      info = await lstat(absolute)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Host handoff tree must not contain symbolic links: ${relativePath}`)
    }
    if (!info.isDirectory()) {
      entries++
      bytes += info.isFile() ? info.size : 0
      if (entries > HANDOFF_TREE_MAX_ENTRIES || bytes > HANDOFF_TREE_MAX_BYTES) {
        throw new Error('Host handoff tree exceeds the bounded baseline scan limit')
      }
      paths.push(relativePath)
      return
    }
    const children = await readdir(absolute, { withFileTypes: true })
    for (const child of children) {
      const childRelative = `${relativePath}/${child.name}`
      await walk(join(absolute, child.name), childRelative)
    }
  }

  await walk(root, rootRelative)
  return paths.sort()
}

function pathPrefixWithinGitRoot(gitRoot: string, absolute: string): string | undefined {
  const value = relative(gitRoot, resolve(absolute)).split(sep).join('/')
  if (value === '' || value === '..' || value.startsWith('../') || isAbsolute(value)) return undefined
  return value.replace(/\/$/, '')
}

async function ignoredScanExceptions(gitRoot: string, cwd: string, baselineDirectory: string): Promise<string[]> {
  const cwdPrefix = pathFromGitRoot(gitRoot, cwd)
  const handoffPrefix = [cwdPrefix, '.dsh-handoff'].filter(Boolean).join('/')
  const configuredPaths = [
    baselineDirectory,
    process.env.DSH_GATE_RUNTIME_STATE_DIR?.trim(),
    process.env.DSH_HOME?.trim(),
  ].filter((value): value is string => value !== undefined && value !== '')
  const configured = (await Promise.all(configuredPaths.map(async value => realpath(value).catch(() => resolve(value)))))
    .map(value => pathPrefixWithinGitRoot(gitRoot, value))
    .filter((value): value is string => value !== undefined)
  // The handoff tree is scanned separately with symlink, entry, and byte
  // bounds. All other Git-ignored paths remain subject to the scope baseline.
  return [...new Set([handoffPrefix, ...configured])].sort()
}

async function observablePaths(gitRoot: string, cwd: string, baselineDirectory: string): Promise<ObservablePathSet> {
  const ignoredExceptions = await ignoredScanExceptions(gitRoot, cwd, baselineDirectory)
  const [dirty, handoff] = await Promise.all([
    gitDirtyPaths(gitRoot, ignoredExceptions),
    handoffTreePaths(gitRoot, cwd),
  ])
  const handoffSet = new Set(handoff)
  return {
    paths: [...new Set([...dirty.paths, ...handoff])].sort(),
    metadataOnly: new Set([...dirty.metadataOnly].filter(path => !handoffSet.has(path))),
  }
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

async function pathFingerprint(gitRoot: string, path: string, metadataOnly = false): Promise<string> {
  const absolute = join(gitRoot, ...path.split('/'))
  try {
    const info = await lstat(absolute, { bigint: true })
    if (info.isSymbolicLink()) return `symlink:${createHash('sha256').update(await readlink(absolute)).digest('hex')}`
    if (info.isFile()) {
      const mode = Number(info.mode & 0o7777n).toString(8)
      return metadataOnly
        ? `file-metadata:${mode}:${String(info.size)}:${String(info.mtimeNs)}:${String(info.ctimeNs)}`
        : `file:${mode}:${await hashFile(absolute)}`
    }
    if (info.isDirectory()) {
      const head = await gitText(absolute, ['rev-parse', 'HEAD']).catch(() => 'not-a-repository')
      const status = await git(absolute, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'buffer')
        .catch(() => Buffer.from('not-a-repository')) as Buffer
      return `directory:${head}:${createHash('sha256').update(status).digest('hex')}`
    }
    return `other:${String(info.mode)}:${String(info.size)}`
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

function admittedHandoffArtifactSet(
  cwdPrefix: string,
  runId: string,
  paths: readonly string[] | undefined,
): ReadonlySet<string> {
  if (paths === undefined || !/^[A-Za-z0-9_-]+$/.test(runId)) return new Set()
  const handoffPrefix = `.dsh-handoff/${runId}/`
  return new Set(paths.flatMap((entry) => {
    const raw = entry.trim().replaceAll('\\', '/')
    if (raw === '' || raw.includes('\u0000') || posix.isAbsolute(raw)) return []
    const normalized = posix.normalize(raw).replace(/^\.\//, '')
    if (!normalized.startsWith(handoffPrefix)) return []
    return [[cwdPrefix, normalized].filter(Boolean).join('/')]
  }))
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
    const observable = await observablePaths(gitRoot, cwd, this.directory)
    const dirty: DirtyFingerprint[] = []
    for (const path of observable.paths) {
      dirty.push({ path, fingerprint: await pathFingerprint(gitRoot, path, observable.metadataOnly.has(path)) })
    }
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

  async verify(input: {
    sessionId: string
    runId: string
    cwd: string
    admittedHandoffArtifactPaths?: readonly string[]
  }): Promise<GitBaselineVerification> {
    const baseline = await this.read(input.sessionId, input.runId)
    if (baseline === undefined) throw new Error(`missing Host Git baseline for run ${input.runId}`)
    if (baseline.sessionId !== input.sessionId || baseline.runId !== input.runId) {
      throw new Error('Host Git baseline record identity does not match its durable key')
    }
    if (baseline.cwd !== await realpath(input.cwd)) throw new Error('session cwd no longer matches its Host Git baseline')
    const headAfter = await gitText(baseline.gitRoot, ['rev-parse', 'HEAD'])
    const currentDirty = await observablePaths(baseline.gitRoot, baseline.cwd, this.directory)
    const committed = headAfter === baseline.head
      ? []
      : await gitPaths(baseline.gitRoot, ['diff', '--name-only', '--no-renames', '-z', `${baseline.head}..${headAfter}`, '--'])
    const baselineDirty = new Map(baseline.dirty.map(entry => [entry.path, entry.fingerprint]))
    const candidates = [...new Set([...baselineDirty.keys(), ...currentDirty.paths, ...committed])].sort()
    const changedPaths: string[] = []
    for (const path of candidates) {
      if (committed.includes(path) || !baselineDirty.has(path)) {
        changedPaths.push(path)
        continue
      }
      const previous = baselineDirty.get(path)
      if (await pathFingerprint(baseline.gitRoot, path, previous?.startsWith('file-metadata:') === true) !== previous) {
        changedPaths.push(path)
      }
    }
    const admittedArtifacts = admittedHandoffArtifactSet(
      pathFromGitRoot(baseline.gitRoot, baseline.cwd), input.runId, input.admittedHandoffArtifactPaths,
    )
    const outOfScopePaths = changedPaths.filter(path => !admittedArtifacts.has(path)
      && !baseline.allowedPrefixes.some(prefix => within(path, prefix)))
    return { headBefore: baseline.head, headAfter, changedPaths, outOfScopePaths }
  }
}
