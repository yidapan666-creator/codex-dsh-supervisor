// dsh-gate bootstrap/doctor/host core library.
//
// Pure logic and small helpers only: no process is spawned and no file is
// touched at import time. The CLI entry (dsh-gate.mjs) wires the real `io`
// (fs, child_process, fetch) and this module stays unit-testable with fakes.
//
// Compatibility contract (see DEPLOYMENT.md):
//   - the generic DSH network-client seam is consumed from the public fork at
//     exactly DSH_PINNED_COMMIT — never from a moving branch;
//   - all generated state (managed clone, DSH_HOME, logs, host metadata,
//     install metadata) lives under one gitignored repository-local dir.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Compatibility contract constants
// ---------------------------------------------------------------------------

/** Public fork of DeepSeek Harness carrying the generic network-client seam. */
export const DSH_FORK_URL = 'https://github.com/yidapan666-creator/deepseek-harness.git'

/**
 * Exact pinned fork commit. This SHA, not the branch, is the compatibility
 * contract; fetching is always by SHA. To update the pin, change this
 * constant, remove the managed checkout, and re-run bootstrap.
 */
export const DSH_PINNED_COMMIT = '7212c955438c70c9a2d168f67e85a8014b8d4488'

/** Informational only: the fork branch that carries the pinned commit. */
export const DSH_FORK_BRANCH = 'codex/mcp-network-client'

/** Name of the single gitignored repository-local state directory. */
export const DEFAULT_STATE_DIR_NAME = '.dsh-state'

/** Default Host origin the doctor probes and host commands use. */
export const DEFAULT_HOST_URL = 'http://127.0.0.1:8080'

/** Host argv: bind loopback only, fixed port, never open a browser. */
export const HOST_ARGV = ['web', '--host', '127.0.0.1', '--port', '8080', '--no-open']

/** Network-client subpath the MCP server imports from the linked package. */
export const NETWORK_CLIENT_SUBPATH = 'network-client'

/** Relative path (inside the DSH checkout) of the connection package. */
export const DSH_CONNECTION_PACKAGE = join('packages', 'client', 'connection')

/** Profile the supervisor plugin is installed into. */
export const SUPERVISOR_PROFILE = 'web'

export const SUPERVISOR_PLUGIN_NAME = '@dsh-gate/supervisor-tools'

export const GITHUB_REMOTE_PATTERN = /^(?:(?:https?|git):\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)(?<owner>[^/\s]+)\/(?<repo>[^/\s]+?)(?:\.git)?\/?$/i

export const PLACEHOLDER_VERSION_PATTERN = /^(?:0\.0\.0|unknown|dev|development|placeholder|unset|n\/a)$/i

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Resolve every path the workflow touches. `root` is the dsh-gate checkout
 * root; defaults derive from this module's location so invocations are
 * repo-root-anchored regardless of the caller's cwd.
 */
export function resolvePaths(options = {}) {
  const root = resolve(options.root ?? dirname(fileURLToPath(import.meta.url)) + '/..')
  const stateDir = resolve(options.state ?? join(root, DEFAULT_STATE_DIR_NAME))
  const dshRepo = resolve(options.dshRepo ?? join(stateDir, 'dsh'))
  const dshHome = resolve(options.dshHome ?? join(stateDir, 'dsh-home'))
  return {
    root,
    stateDir,
    dshRepo,
    dshHome,
    logsDir: join(stateDir, 'logs'),
    hostDir: join(stateDir, 'host'),
    installJson: join(stateDir, 'install.json'),
    hostPidFile: join(stateDir, 'host', 'host.pid'),
    hostStartLockFile: join(stateDir, 'host', 'host.start.lock'),
    hostLogFile: join(stateDir, 'logs', 'host.log'),
    linkPath: join(root, 'packages', 'mcp-server', 'node_modules', '@deepseek-ai', 'dsh-client-connection'),
    pluginPath: join(root, 'packages', 'dsh-supervisor-tools'),
    mcpServerDistCli: join(root, 'packages', 'mcp-server', 'dist', 'cli.js'),
    dshBin: join(dshRepo, 'apps', 'cli', 'lib', 'bin.js'),
    dshConnectionLib: join(dshRepo, DSH_CONNECTION_PACKAGE, 'lib', `${NETWORK_CLIENT_SUBPATH}.js`),
    webDistIndex: join(dshRepo, 'apps', 'web', 'dist', 'index.html'),
    profileManifest: join(dshHome, 'profiles', SUPERVISOR_PROFILE, 'package.json'),
    workerSkillSource: join(root, 'skills', 'dsh-supervised-worker', 'SKILL.md'),
    workerSkillDestination: join(dshHome, 'skills', 'dsh-supervised-worker', 'SKILL.md'),
  }
}

function localHostAddress(hostUrl = DEFAULT_HOST_URL) {
  const parsed = new URL(hostUrl)
  if (parsed.protocol !== 'http:') throw new Error(`Host launch URL must use http: ${hostUrl}`)
  if (parsed.username !== '' || parsed.password !== '') throw new Error('Host launch URL must not contain credentials')
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`Host launch URL must be an origin without path, query, or fragment: ${hostUrl}`)
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`Host launch must bind loopback, not ${parsed.hostname}`)
  }
  const port = parsed.port === '' ? '8080' : parsed.port
  const hostname = parsed.hostname === '[::1]' ? '::1' : parsed.hostname
  const keyHost = hostname === '::1' ? 'ipv6-loopback' : hostname.replace(/[^a-zA-Z0-9.-]/g, '_')
  return {
    hostname,
    port,
    canonicalUrl: `http://${hostname === '::1' ? '[::1]' : hostname}:${port}`,
    stateKey: `http-${keyHost}-${port}`,
  }
}

/** Isolate lifecycle ownership by Host origin so one port can never erase another port's state. */
export function resolveHostStatePaths(paths, hostUrl = DEFAULT_HOST_URL) {
  const address = localHostAddress(hostUrl)
  return {
    ...paths,
    hostPidFile: join(paths.hostDir, `${address.stateKey}.pid`),
    hostStartLockFile: join(paths.hostDir, `${address.stateKey}.start.lock`),
    hostLogFile: join(paths.logsDir, `${address.stateKey}.log`),
    legacyHostPidFile: paths.hostPidFile,
    canonicalHostUrl: address.canonicalUrl,
  }
}

// ---------------------------------------------------------------------------
// CLI parsing (pure)
// ---------------------------------------------------------------------------

export const COMMANDS = ['bootstrap', 'doctor', 'host']

export const HOST_ACTIONS = ['start', 'run', 'status', 'stop']

export const OPTION_SPEC = new Set([
  '--state', '--dsh-repo', '--dsh-home', '--host', '--session', '--dry-run', '--force', '--live', '--help', '--version',
])

/**
 * Parse the CLI argv (process.argv.slice(2)) into a command and options.
 * Pure: no fs, no env. Unknown options and stray positionals are rejected.
 */
export function parseCliArgs(argv) {
  const options = {}
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }
    const [flag, ...rest] = token.split('=')
    if (!OPTION_SPEC.has(flag)) throw new Error(`unknown option ${flag}`)
    if (['--state', '--dsh-repo', '--dsh-home', '--host', '--session'].includes(flag)) {
      const inline = rest.join('=')
      const value = inline !== '' ? inline : argv[i + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`option ${flag} needs a value`)
      if (inline === '') i += 1
      options[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
    } else {
      options[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true
    }
  }
  const command = positionals.shift()
  if (command === undefined) {
    if (options.help) return { command: 'help', options }
    if (options.version) return { command: 'version', options }
    throw new Error('missing command: bootstrap | doctor | host')
  }
  if (!COMMANDS.includes(command)) throw new Error(`unknown command ${command}`)
  let hostAction
  if (command === 'host') {
    hostAction = positionals.shift()
    if (hostAction === undefined) throw new Error('host needs an action: start | run | status | stop')
    if (!HOST_ACTIONS.includes(hostAction)) throw new Error(`unknown host action ${hostAction}`)
  }
  if (positionals.length > 0) throw new Error(`unexpected argument ${positionals[0]}`)
  for (const key of ['dryRun', 'force', 'live', 'help', 'version']) {
    if (options[key] === undefined) options[key] = false
  }
  return { command, hostAction, options }
}

export function usageText() {
  return [
    'dsh-gate — reproducible DSH fork bootstrap, doctor, and Host lifecycle',
    '',
    'Usage:',
    '  node scripts/dsh-gate.mjs bootstrap [--state DIR] [--dsh-repo DIR] [--dsh-home DIR] [--dry-run] [--force]',
    '  node scripts/dsh-gate.mjs doctor   [--state DIR] [--dsh-repo DIR] [--dsh-home DIR] [--live] [--host URL] [--session ID]',
    '  node scripts/dsh-gate.mjs host     start|run|status|stop [--state DIR] [--dsh-repo DIR] [--dsh-home DIR] [--host URL] [--dry-run]',
    '',
    'Options:',
    '  --state DIR      state directory (default: <repo>/.dsh-state)',
    '  --dsh-repo DIR   managed DSH checkout (default: <state>/dsh); an explicit',
    '                   checkout must be at the pinned commit and carry the fork remote',
    '  --dsh-home DIR   isolated DSH_HOME (default: <state>/dsh-home)',
    '  --host URL       Host origin for doctor --live / host commands (default: http://127.0.0.1:8080)',
    '  --dry-run        plan only: print phases/commands, change nothing',
    '  --force          re-run install/build phases even when markers say they are current',
    '  --live           doctor: also probe a live Host (protocolVersion, hostInstanceId, version)',
    '  --session ID     doctor --live: verify the attached session has a routable provider/model (no model call)',
    '  host run         keep the Host attached for launchd/systemd process supervision',
    '  --help, --version',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Normalize a remote URL for identity comparison (scheme-agnostic GitHub). */
export function normalizeRemoteUrl(url) {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
}

/**
 * Whether a remote URL identifies the pinned fork. Accepts https and
 * ssh-style GitHub spellings; compares owner/repo, never a machine path.
 */
export function remoteMatchesFork(remoteUrl, forkUrl = DSH_FORK_URL) {
  const remote = remoteUrl.trim()
  const remoteMatch = GITHUB_REMOTE_PATTERN.exec(remote)
  const forkMatch = GITHUB_REMOTE_PATTERN.exec(forkUrl)
  if (remoteMatch !== null && forkMatch !== null) {
    return remoteMatch.groups.owner.toLowerCase() === forkMatch.groups.owner.toLowerCase()
      && remoteMatch.groups.repo.toLowerCase() === forkMatch.groups.repo.toLowerCase()
  }
  return normalizeRemoteUrl(remote) === normalizeRemoteUrl(forkUrl)
}

export function isPlaceholderVersion(version) {
  if (typeof version !== 'string') return true
  const value = version.trim()
  if (value === '') return true
  if (PLACEHOLDER_VERSION_PATTERN.test(value)) return true
  return value.includes('{{') || value.includes('${') || /<[a-z]+>/i.test(value)
}

/** Redact credential-looking substrings from command output before printing. */
export function redactOutput(text) {
  if (typeof text !== 'string' || text === '') return text
  const key = '(?:DSH_[A-Z0-9_]+|(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTH(?:ORIZATION)?|CREDENTIAL)[A-Z0-9_]*)'
  return text.replace(new RegExp(`\\b${key}\\s*[=:]\\s*\\S+`, 'gi'), (match) => {
    const separator = /[=:]/.exec(match)
    return `${match.slice(0, separator.index + 1)}<redacted>`
  })
}

/** Tail of a redacted command output, bounded for a failure report. */
export function formatOutputTail(text, maxLines = 15) {
  const lines = redactOutput(text ?? '').split('\n')
  const tail = lines.slice(-maxLines)
  if (lines.length > maxLines) tail.unshift(`… ${lines.length - maxLines} earlier line(s) omitted`)
  return tail.join('\n')
}

/**
 * Human-readable failure report for one failed phase. Never prints the
 * environment; the command is argv only (cwd included, env excluded).
 */
export function formatPhaseFailure({ phase, argv, cwd, exitCode, output, hint }) {
  const lines = [
    `[dsh-gate] phase "${phase}" failed`,
    `[dsh-gate] command: ${argv.map(quoteArg).join(' ')}${cwd === undefined ? '' : `   (cwd: ${cwd})`}`,
    `[dsh-gate] exit code: ${String(exitCode)}`,
  ]
  if (output !== undefined && output !== '') {
    lines.push(`[dsh-gate] last output:\n${formatOutputTail(output)}`)
  }
  if (hint !== undefined) lines.push(`[dsh-gate] fix: ${hint}`)
  return lines.join('\n')
}

function quoteArg(argument) {
  return /[\s"']/.test(argument) ? JSON.stringify(argument) : argument
}

// ---------------------------------------------------------------------------
// Managed checkout validation and acquisition
// ---------------------------------------------------------------------------

/** Read `git remote -v` as name -> urls. */
export async function gitRemoteUrls(dir, io) {
  const result = await io.exec('git', ['remote', '-v'], { cwd: dir })
  const urls = new Set()
  if (result.status !== 0) return urls
  for (const line of result.stdout.split('\n')) {
    const match = /^\S+\s+(\S+)/.exec(line.trim())
    if (match !== null) urls.add(match[1])
  }
  return urls
}

/**
 * Validate an existing checkout against the compatibility contract without
 * mutating it. Refusals are never "recovered" destructively here: a dirty or
 * mismatched checkout fails with an actionable message.
 */
export async function validateCheckout(dir, io, { forkUrl = DSH_FORK_URL, pinnedSha = DSH_PINNED_COMMIT } = {}) {
  const problems = []
  const details = {}
  if (!(await io.exists(join(dir, '.git')))) {
    return { ok: false, problems: [`${dir} is not a git repository`], details }
  }
  const head = await io.exec('git', ['rev-parse', 'HEAD'], { cwd: dir })
  details.head = head.status === 0 ? head.stdout.trim() : undefined
  if (head.status !== 0) {
    problems.push(`cannot read HEAD: ${head.stderr.trim()}`)
  } else if (head.stdout.trim() !== pinnedSha) {
    problems.push(`HEAD is ${head.stdout.trim()} but the pin requires ${pinnedSha}`)
  }
  const remotes = await gitRemoteUrls(dir, io)
  details.remotes = [...remotes]
  if (![...remotes].some(url => remoteMatchesFork(url, forkUrl))) {
    problems.push(`no git remote matches the pinned fork ${forkUrl}`)
  }
  const porcelain = await io.exec('git', ['status', '--porcelain'], { cwd: dir })
  const lines = (porcelain.status === 0 ? porcelain.stdout : '').split('\n').filter(line => line !== '')
  const trackedChanges = lines.filter(line => !line.startsWith('?? '))
  const untracked = lines.filter(line => line.startsWith('?? ')).length
  details.trackedChanges = trackedChanges.length
  details.untracked = untracked
  if (trackedChanges.length > 0) {
    problems.push(`${trackedChanges.length} tracked file(s) differ from the pinned commit (refusing to build a dirty checkout)`)
  }
  if (untracked > 0) {
    problems.push(`${untracked} untracked path(s) are present (refusing to build a dirty checkout)`)
  }
  return { ok: problems.length === 0, problems, details }
}

/**
 * Commands that obtain the managed checkout when absent: init, add the fork
 * remote, fetch ONLY the pinned commit (shallow, by SHA — never a branch),
 * and check it out detached.
 */
export function obtainCheckoutCommands({ dir, forkUrl = DSH_FORK_URL, pinnedSha = DSH_PINNED_COMMIT }) {
  return [
    ['git', ['init', dir]],
    ['git', ['-C', dir, 'remote', 'add', 'origin', forkUrl]],
    ['git', ['-C', dir, 'fetch', '--depth', '1', 'origin', pinnedSha]],
    ['git', ['-C', dir, 'checkout', '--detach', 'FETCH_HEAD']],
  ]
}

// ---------------------------------------------------------------------------
// Link reuse (scripts/link-local-dsh.mjs)
// ---------------------------------------------------------------------------

/** Command that links the network client from the checkout into mcp-server. */
export function linkCommand({ root, dshRepo }) {
  return {
    argv: [process.execPath, join(root, 'scripts', 'link-local-dsh.mjs'), dshRepo],
    cwd: root,
  }
}

/** Whether the mcp-server link already resolves to the checkout's connection package. */
export async function linkTargetMatches({ linkPath, dshRepo, io }) {
  const target = join(dshRepo, DSH_CONNECTION_PACKAGE)
  const [linkReal, targetReal] = await Promise.all([
    io.realpath(linkPath).catch(() => undefined),
    io.realpath(target).catch(() => undefined),
  ])
  return linkReal !== undefined && targetReal !== undefined && linkReal === targetReal
}

// ---------------------------------------------------------------------------
// pnpm invocation
// ---------------------------------------------------------------------------

/**
 * Prefer the repo-pinned pnpm via corepack when it works; fall back to the
 * `pnpm` on PATH. Returns { argv, via, version } — version is recorded for
 * install metadata, never treated as a hard contract (all 11.x share the
 * lockfile format used by both repositories).
 */
export async function resolvePnpm(io) {
  const corepackProbe = await io.exec('corepack', ['pnpm', '--version'], { timeoutMs: 20000 }).catch(() => ({ status: 1 }))
  if (corepackProbe.status === 0) {
    return { argv: ['corepack', 'pnpm'], via: 'corepack', version: corepackProbe.stdout.trim() }
  }
  const pnpmProbe = await io.exec('pnpm', ['--version'], { timeoutMs: 20000 })
  if (pnpmProbe.status !== 0) {
    throw new Error('no usable pnpm: corepack is unavailable and `pnpm` is not on PATH')
  }
  return { argv: ['pnpm'], via: 'path', version: pnpmProbe.stdout.trim() }
}

// ---------------------------------------------------------------------------
// Bootstrap planning
// ---------------------------------------------------------------------------

/**
 * Decide, for each bootstrap phase, whether it runs or is skipped, and with
 * which command. Read-only (io.exists only). Returns an ordered phase list.
 */
export async function planBootstrap({ paths, io, force = false, pnpm, gateSha, checkout }) {
  const phases = []
  // A dirty development tree has no immutable content id. Rebuild workspace
  // phases every time instead of treating HEAD alone as a valid cache key.
  const gateTreeStable = typeof gateSha === 'string' && !gateSha.endsWith('-dirty')

  phases.push({
    name: 'checkout',
    description: 'obtain or validate the pinned DSH fork commit',
    argv: undefined,
    action: checkout.ok ? 'skip' : 'run',
    skipReason: checkout.ok ? 'checkout present and valid (exact pinned commit, fork remote, worktree clean)' : undefined,
    hint: checkout.ok ? undefined : `checkout at ${paths.dshRepo} is absent, dirty, or mismatched; see DEPLOYMENT.md "Clean failure recovery"`,
  })

  const installJson = await io.readJson(paths.installJson).catch(() => undefined)
  const dshInstallCurrent = !force
    && installJson?.steps?.dshInstall?.done === true
    && installJson.steps.dshInstall.sha === DSH_PINNED_COMMIT
    && await io.exists(join(paths.dshRepo, 'node_modules'))
  phases.push({
    name: 'dsh-install',
    description: `install DSH dependencies (${pnpm.via === 'corepack' ? 'corepack-pinned pnpm' : 'pnpm on PATH'})`,
    argv: [...pnpm.argv, 'install', '--frozen-lockfile'],
    cwd: paths.dshRepo,
    action: dshInstallCurrent ? 'skip' : 'run',
    skipReason: dshInstallCurrent ? 'already installed at the pinned commit (--force to redo)' : undefined,
  })

  const dshBuildCurrent = !force
    && installJson?.steps?.dshBuild?.done === true
    && installJson.steps.dshBuild.sha === DSH_PINNED_COMMIT
    && await io.exists(paths.dshBin)
    && await io.exists(paths.webDistIndex)
    && await io.exists(paths.dshConnectionLib)
  phases.push({
    name: 'dsh-build',
    description: 'build DSH (lib + web) at the pinned commit',
    argv: [...pnpm.argv, 'build'],
    cwd: paths.dshRepo,
    action: dshBuildCurrent ? 'skip' : 'run',
    skipReason: dshBuildCurrent ? 'DSH build outputs already present for the pinned commit (--force to redo)' : undefined,
  })

  const gateInstallCurrent = !force
    && gateTreeStable
    && installJson?.steps?.gateInstall?.done === true
    && installJson.steps.gateInstall.gateSha === gateSha
    && await io.exists(join(paths.root, 'node_modules'))
  phases.push({
    name: 'gate-install',
    description: 'install dsh-gate workspace dependencies',
    argv: [...pnpm.argv, 'install', '--frozen-lockfile'],
    cwd: paths.root,
    action: gateInstallCurrent ? 'skip' : 'run',
    skipReason: gateInstallCurrent ? 'dsh-gate dependencies already installed for this tree (--force to redo)' : undefined,
  })

  const linkCurrent = await linkTargetMatches({ linkPath: paths.linkPath, dshRepo: paths.dshRepo, io })
  phases.push({
    name: 'link',
    description: 'link the exact network client via scripts/link-local-dsh.mjs',
    argv: linkCommand({ root: paths.root, dshRepo: paths.dshRepo }).argv,
    cwd: paths.root,
    action: linkCurrent ? 'skip' : 'run',
    skipReason: linkCurrent ? 'network-client link already points at the managed checkout' : undefined,
  })

  const gateBuildCurrent = !force
    && gateTreeStable
    && installJson?.steps?.gateBuild?.done === true
    && installJson.steps.gateBuild.gateSha === gateSha
    && await io.exists(paths.mcpServerDistCli)
  phases.push({
    name: 'gate-build',
    description: 'build dsh-gate packages',
    argv: [...pnpm.argv, 'build'],
    cwd: paths.root,
    action: gateBuildCurrent ? 'skip' : 'run',
    skipReason: gateBuildCurrent ? 'dsh-gate build outputs already present for this tree (--force to redo)' : undefined,
  })

  const profileCurrent = !force
    && installJson?.steps?.plugin?.done === true
    && installJson.steps.plugin.sha === DSH_PINNED_COMMIT
    && await profileHasPlugin(paths, io)
  phases.push({
    name: 'plugin',
    description: `install ${SUPERVISOR_PLUGIN_NAME} into the isolated DSH_HOME ${SUPERVISOR_PROFILE} profile`,
    argv: [process.execPath, paths.dshBin, 'plugin', '--profile', SUPERVISOR_PROFILE, 'add', paths.pluginPath],
    cwd: paths.root,
    env: { DSH_HOME: paths.dshHome },
    action: profileCurrent ? 'skip' : 'run',
    skipReason: profileCurrent ? 'supervisor plugin already installed in the isolated profile (--force to redo)' : undefined,
  })

  const workerSkillCurrent = !force
    && await Promise.all([
      io.readFile(paths.workerSkillSource).catch(() => undefined),
      io.readFile(paths.workerSkillDestination).catch(() => undefined),
    ]).then(([source, installed]) => source !== undefined && source === installed)
  phases.push({
    name: 'worker-skill',
    description: 'install the supervised worker contract into the isolated DSH_HOME skill catalog',
    argv: undefined,
    action: workerSkillCurrent ? 'skip' : 'run',
    skipReason: workerSkillCurrent ? 'DSH worker skill already matches this checkout' : undefined,
  })

  phases.push({
    name: 'metadata',
    description: 'write install metadata ('.concat(paths.installJson, ')'),
    argv: undefined,
    action: 'run',
  })

  return phases
}

/** Whether the isolated profile manifest already lists the supervisor bundle. */
export async function profileHasPlugin(paths, io) {
  const manifest = await io.readJson(paths.profileManifest).catch(() => undefined)
  if (manifest === undefined) return false
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return false
  return bundles.includes(SUPERVISOR_PLUGIN_NAME)
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

export async function checkLiveHost({ url, io, timeoutMs = 8000 }) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `dsh-gate-${Date.now().toString(36)}`,
    method: 'host.describe',
    payload: {},
  })
  const response = await io.fetch(`${url.replace(/\/+$/, '')}/api/host.describe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const envelope = await response.json()
  const result = envelope?.result
  if (result === undefined || result.ok !== true) {
    const error = result?.error
    throw new Error(error === undefined ? 'malformed host.describe response' : `${error.code}: ${error.message}`)
  }
  return result.value
}

export async function checkSessionModels({ url, sessionId, io, timeoutMs = 8000 }) {
  const rpcId = `dsh-gate-models-${Date.now().toString(36)}`
  const response = await io.fetch(`${url.replace(/\/+$/, '')}/api/session.models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId, method: 'session.models', payload: { sessionId },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const envelope = await response.json()
  const result = envelope?.result
  if (result === undefined || result.ok !== true) {
    const error = result?.error
    throw new Error(error === undefined ? 'malformed sessions.models response' : `${error.code}: ${error.message}`)
  }
  return result.value
}

/**
 * Run every doctor check. `io` is the real or fake io; `live` enables the
 * optional Host probe. Returns an ordered list of check results.
 */
export async function runDoctor({ paths, io, live = false, hostUrl = DEFAULT_HOST_URL, readinessSession }) {
  const checks = []
  const add = (name, run) => checks.push({ name, run })

  add('install metadata', async () => {
    const data = await io.readJson(paths.installJson).catch(() => undefined)
    if (data === undefined) {
      return { ok: false, detail: `no ${paths.installJson} — run 'pnpm bootstrap' first` }
    }
    const mismatches = []
    if (data.pinnedCommit !== DSH_PINNED_COMMIT) mismatches.push(`recorded pin ${data.pinnedCommit} differs from ${DSH_PINNED_COMMIT}`)
    if (data.forkUrl !== DSH_FORK_URL) mismatches.push(`recorded fork ${data.forkUrl} differs from ${DSH_FORK_URL}`)
    return mismatches.length === 0
      ? { ok: true, detail: `pin ${data.pinnedCommit} recorded at ${data.updatedAt ?? 'unknown time'}` }
      : { ok: false, detail: mismatches.join('; ') }
  })

  add('managed checkout', async () => {
    const result = await validateCheckout(paths.dshRepo, io)
    return result.ok
      ? { ok: true, detail: `HEAD ${result.details.head} matches the pin; fork remote present; checkout clean` }
      : { ok: false, detail: result.problems.join('; ') }
  })

  add('DSH build outputs', async () => {
    const missing = []
    for (const [label, path] of [
      ['dsh CLI', paths.dshBin],
      ['network-client lib', paths.dshConnectionLib],
      ['web frontend dist', paths.webDistIndex],
    ]) {
      if (!(await io.exists(path))) missing.push(label)
    }
    return missing.length === 0
      ? { ok: true, detail: 'dsh CLI, network-client lib, and web frontend dist are built' }
      : { ok: false, detail: `missing: ${missing.join(', ')}` }
  })

  add('network-client link', async () => {
    const matches = await linkTargetMatches({ linkPath: paths.linkPath, dshRepo: paths.dshRepo, io })
    const stat = await io.lstat(paths.linkPath).catch(() => undefined)
    if (matches) {
      const kind = stat?.isSymbolicLink() === true ? 'symlink' : 'directory'
      return { ok: true, detail: `${kind} resolves to the managed checkout's ${DSH_CONNECTION_PACKAGE}` }
    }
    return { ok: false, detail: 'mcp-server link does not resolve to the managed checkout — re-run bootstrap' }
  })

  add('built MCP entry', async () => {
    if (!(await io.exists(paths.mcpServerDistCli))) {
      return { ok: false, detail: `missing ${paths.mcpServerDistCli}` }
    }
    const check = await io.exec(process.execPath, ['--check', paths.mcpServerDistCli])
    return check.status === 0
      ? { ok: true, detail: 'packages/mcp-server/dist/cli.js exists and parses' }
      : { ok: false, detail: `cli.js fails to parse: ${check.stderr.trim()}` }
  })

  add('supervisor plugin / profile', async () => {
    const missing = []
    if (!(await io.exists(join(paths.pluginPath, 'dist', 'index.js')))) missing.push('plugin dist/index.js (run bootstrap)')
    if (!(await io.exists(paths.profileManifest))) missing.push('profile manifest (run bootstrap)')
    if (missing.length > 0) return { ok: false, detail: `missing: ${missing.join(', ')}` }
    const manifest = await io.readJson(paths.profileManifest)
    const bundles = manifest.dsh?.profile?.bundles
    const installed = manifest.dependencies?.[SUPERVISOR_PLUGIN_NAME] !== undefined || Array.isArray(bundles) && bundles.includes(SUPERVISOR_PLUGIN_NAME)
    if (!installed) {
      return { ok: false, detail: `${SUPERVISOR_PLUGIN_NAME} is not installed in the ${SUPERVISOR_PROFILE} profile` }
    }
    const patchPath = join(paths.pluginPath, 'cordis.patch.yml')
    if (!(await io.exists(patchPath))) return { ok: false, detail: `missing supervisor profile patch ${patchPath}` }
    const patch = String(await io.readFile(patchPath))
    const nativeDepthCaps = patch.match(/maxDepth:\s*1\b/g)?.length ?? 0
    if (nativeDepthCaps < 2 || !patch.includes('- subagent') || !patch.includes('- subagent_fork')) {
      return { ok: false, detail: 'supervisor profile patch is missing native Root-to-child depth caps or direct-child tool coverage' }
    }
    return { ok: true, detail: `${SUPERVISOR_PLUGIN_NAME} listed in ${SUPERVISOR_PROFILE} profile bundles; native depth-1 caps and both direct-child tools are configured` }
  })

  add('DSH worker skill', async () => {
    const source = await io.readFile(paths.workerSkillSource).catch(() => undefined)
    const installed = await io.readFile(paths.workerSkillDestination).catch(() => undefined)
    if (source === undefined) return { ok: false, detail: `missing repository worker skill ${paths.workerSkillSource}` }
    if (installed === undefined) return { ok: false, detail: `worker skill is not installed at ${paths.workerSkillDestination}; run 'pnpm bootstrap'` }
    return source === installed
      ? { ok: true, detail: 'isolated DSH_HOME worker skill matches this checkout' }
      : { ok: false, detail: 'installed DSH worker skill is stale; run \'pnpm bootstrap\'' }
  })

  if (live) {
    add('live Host', async () => {
      let value
      try {
        value = await checkLiveHost({ url: hostUrl, io })
      } catch (error) {
        return { ok: false, detail: `no live Host at ${hostUrl}: ${error instanceof Error ? error.message : String(error)}` }
      }
      const failures = []
      if (value.protocolVersion !== 1) failures.push(`protocolVersion ${String(value.protocolVersion)} (expected 1)`)
      if (typeof value.hostInstanceId !== 'string' || value.hostInstanceId === '') failures.push('hostInstanceId missing')
      if (isPlaceholderVersion(value.version)) failures.push(`version ${JSON.stringify(value.version)} is a placeholder`)
      return failures.length === 0
        ? { ok: true, detail: `protocolVersion 1; hostInstanceId ${value.hostInstanceId}; version ${value.version}` }
        : { ok: false, detail: failures.join('; ') }
    })
    if (readinessSession !== undefined) {
      add('provider/model routing', async () => {
        let value
        try {
          value = await checkSessionModels({ url: hostUrl, sessionId: readinessSession, io })
        } catch (error) {
          return { ok: false, detail: `session ${readinessSession}: ${error instanceof Error ? error.message : String(error)}` }
        }
        const provider = value?.current?.provider
        const model = value?.current?.model
        const failures = Array.isArray(value?.failures) ? value.failures : []
        if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
          return { ok: false, detail: `session ${readinessSession} has no current provider/model` }
        }
        if (value.routable !== true) {
          return { ok: false, detail: `${provider}/${model} is not routable: ${JSON.stringify(failures).slice(0, 512)}` }
        }
        const advisory = failures.length === 0
          ? ''
          : `; ${String(failures.length)} unrelated provider catalog warning(s) reported`
        return {
          ok: true,
          detail: `${provider}/${model} is routable for session ${readinessSession}${advisory}; credentials are verified only by an explicit real task`,
        }
      })
    }
  }

  const results = []
  for (const check of checks) {
    try {
      results.push({ name: check.name, ...(await check.run()) })
    } catch (error) {
      results.push({ name: check.name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

export function summarizeDoctor(results) {
  const width = Math.max(...results.map(result => result.name.length), 0)
  const lines = results.map(result => {
    const status = result.ok ? 'PASS' : 'FAIL'
    return `${result.name.padEnd(width)}  ${status}  ${result.detail}`
  })
  const failed = results.filter(result => !result.ok)
  lines.push('')
  lines.push(failed.length === 0
    ? `doctor: all ${results.length} check(s) passed`
    : `doctor: ${failed.length} of ${results.length} check(s) failed`)
  return { text: lines.join('\n'), ok: failed.length === 0 }
}

// ---------------------------------------------------------------------------
// Host lifecycle
// ---------------------------------------------------------------------------

export async function readHostPidFile(paths, io, hostUrl = paths.canonicalHostUrl ?? DEFAULT_HOST_URL) {
  const expectedUrl = localHostAddress(hostUrl).canonicalUrl
  const candidates = [paths.hostPidFile]
  if (paths.legacyHostPidFile !== undefined && paths.legacyHostPidFile !== paths.hostPidFile) {
    candidates.push(paths.legacyHostPidFile)
  }
  for (const pidFile of candidates) {
    const raw = await io.readFile(pidFile).catch(() => undefined)
    if (raw === undefined || raw.trim() === '') continue
    try {
      const record = JSON.parse(raw)
      if (!Number.isSafeInteger(record?.pid) || record.pid <= 0 || typeof record.url !== 'string') continue
      if (localHostAddress(record.url).canonicalUrl !== expectedUrl) continue
      return { ...record, pidFile }
    } catch {
      // Invalid or foreign records are never guessed to own the requested Host.
    }
  }
  return undefined
}

/**
 * Acquire the short-lived cross-process Host startup lease. The lease protects
 * only PID/port discovery plus startup; it is unrelated to working-tree writer
 * admission. Contenders wait for the winner to publish a ready Host and then
 * re-run the ordinary idempotent checks. An orphan is never guessed stale.
 */
export async function acquireHostStartLease(paths, io, options = {}) {
  const waitMs = options.waitMs ?? 35_000
  const retryMs = options.retryMs ?? 100
  const deadline = Date.now() + waitMs
  const ownedRecord = `${process.pid} ${randomUUID()}\n`
  while (true) {
    try {
      await io.writeFileExclusive(paths.hostStartLockFile, ownedRecord)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for Host startup lease ${paths.hostStartLockFile}; confirm no host:start process is running, then remove the orphaned lease manually`)
    }
    await (io.sleep?.(retryMs) ?? new Promise(resolveWait => setTimeout(resolveWait, retryMs)))
  }
  return async () => {
    const current = await io.readFile(paths.hostStartLockFile).catch(() => undefined)
    if (current !== ownedRecord) {
      throw new Error(`Host startup lease ownership changed at ${paths.hostStartLockFile}; refusing to remove it`)
    }
    await io.rm(paths.hostStartLockFile, { force: true })
  }
}

export function hostIsAlive(pid, io) {
  return probePid(pid, io).then(state => state === 'alive')
}

/**
 * Three-state process probe: 'alive' (ps confirms), 'dead' (ps says gone),
 * or 'unknown' (ps unavailable/restricted — callers fall back to the Host
 * URL probe rather than guessing).
 */
export async function probePid(pid, io) {
  try {
    const result = await io.exec('ps', ['-p', String(pid), '-o', 'command='])
    if (result.error !== undefined) return 'unknown'
    if (result.status === 0 && result.stdout.trim() !== '') return 'alive'
    return 'dead'
  } catch {
    return 'unknown'
  }
}

/**
 * Decide how Host startup treats an existing PID record. Process uncertainty is
 * never evidence of staleness: only a positive `dead` result permits deletion.
 */
export function hostStartPidDecision(pidState, hostReachable) {
  if (hostReachable && (pidState === 'alive' || pidState === 'unknown')) return 'already-running'
  if (pidState === 'alive') return 'refuse-alive-unreachable'
  if (pidState === 'unknown') return 'refuse-unverifiable'
  if (pidState === 'dead') return 'clear-stale'
  throw new Error(`invalid PID state ${String(pidState)}`)
}

/** Describe a running host for status output; throws when unreachable. */
export async function describeHost({ hostUrl, io, timeoutMs = 5000 }) {
  const value = await checkLiveHost({ url: hostUrl, io, timeoutMs })
  return value
}

/** Build the argv used to launch the detached Host process. */
export function hostLaunchArgv({ dshBin, hostUrl = DEFAULT_HOST_URL }) {
  const { hostname, port } = localHostAddress(hostUrl)
  return [process.execPath, dshBin, 'web', '--host', hostname, '--port', port, '--no-open']
}
