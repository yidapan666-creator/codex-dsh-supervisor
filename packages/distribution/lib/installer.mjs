import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, platform as hostPlatform, arch as hostArch, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const BUNDLE_SCHEMA_VERSION = 1
export const MANAGED_BEGIN = '# BEGIN dsh-gate managed block'
export const MANAGED_END = '# END dsh-gate managed block'
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_VERSION = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version
const RELEASE_BASE = 'https://github.com/yidapan666-creator/codex-dsh-supervisor/releases/download'

export function usageText() {
  return [
    'dsh-gate — install and operate the durable DSH supervision bridge',
    '',
    'Usage:',
    '  dsh-gate setup [--version X | --bundle FILE --sha256 HEX] [options]',
    '  dsh-gate upgrade [--version X | --bundle FILE --sha256 HEX] [options]',
    '  dsh-gate uninstall [--install-dir DIR] [--codex-home DIR] [--purge]',
    '',
    'Setup options:',
    '  --install-dir DIR   Stable installation root (default: ~/.local/share/dsh-gate)',
    '  --codex-home DIR    Codex home containing config.toml (default: ~/.codex)',
    '  --skills-dir DIR    Personal skills directory (default: ~/.agents/skills)',
    '  --host URL          Loopback Host origin (default: http://127.0.0.1:8080)',
    '  --bundle FILE       Use a downloaded/offline release bundle',
    '  --sha256 HEX        Required digest for --bundle (or FILE.sha256 sidecar)',
    '  --no-start          Install and configure without starting the Host',
    '  --no-config         Do not update Codex config.toml',
    '  --no-skill          Do not install the Codex supervisor skill',
    '  --force             Preserve-and-replace an existing same-version runtime',
    '  --dry-run           Print resolved actions without changing anything',
  ].join('\n')
}

export function parseArgs(argv) {
  const command = argv[0]
  if (command === undefined || command === '--help' || command === '-h') return { command: 'help' }
  if (command === '--version' || command === '-v') return { command: 'version' }
  if (!['setup', 'upgrade', 'uninstall'].includes(command)) throw new Error(`unknown command ${command}`)
  const options = { start: true, config: true, skill: true, purge: false, force: command === 'upgrade', dryRun: false }
  const valueFlags = new Set(['--version', '--bundle', '--sha256', '--install-dir', '--codex-home', '--skills-dir', '--host'])
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (valueFlags.has(argument)) {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      options[argument.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value
      continue
    }
    if (argument === '--no-start') options.start = false
    else if (argument === '--no-config') options.config = false
    else if (argument === '--no-skill') options.skill = false
    else if (argument === '--purge') options.purge = true
    else if (argument === '--force') options.force = true
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--help' || argument === '-h') return { command: 'help' }
    else throw new Error(`unknown option ${argument}`)
  }
  if (options.bundle !== undefined && options.version !== undefined) throw new Error('--bundle and --version are mutually exclusive')
  if (options.sha256 !== undefined && options.bundle === undefined) throw new Error('--sha256 requires --bundle')
  return { command, options }
}

export function normalizeHostUrl(input = 'http://127.0.0.1:8080') {
  const parsed = new URL(input)
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('--host must be a loopback http origin')
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('--host must be an origin without credentials, path, query, or fragment')
  }
  return parsed.origin
}

export function validateBundleManifest(value, current = { platform: hostPlatform(), arch: hostArch() }) {
  if (value?.schemaVersion !== BUNDLE_SCHEMA_VERSION || value?.product !== 'dsh-gate') throw new Error('unsupported bundle manifest')
  for (const field of ['version', 'gateCommit', 'dshCommit', 'kind', 'platform', 'arch']) {
    if (typeof value[field] !== 'string' || value[field] === '') throw new Error(`bundle manifest is missing ${field}`)
  }
  if (!['online', 'offline'].includes(value.kind)) throw new Error(`unsupported bundle kind ${value.kind}`)
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(value.version)) throw new Error('bundle version is not path-safe')
  if (!/^[0-9a-f]{40,64}$/.test(value.gateCommit) || !/^[0-9a-f]{40,64}$/.test(value.dshCommit)) {
    throw new Error('bundle commits must be full hexadecimal object IDs')
  }
  if (value.platform !== 'any' && value.platform !== current.platform) throw new Error(`bundle platform ${value.platform} does not match ${current.platform}`)
  if (value.arch !== 'any' && value.arch !== current.arch) throw new Error(`bundle architecture ${value.arch} does not match ${current.arch}`)
  return value
}

export function renderCodexBlock({ runtimeDir, stateDir, hostUrl }) {
  const quote = value => JSON.stringify(value)
  const launch = JSON.stringify({ argv: [process.execPath, join(runtimeDir, 'scripts', 'dsh-gate.mjs'), 'host', 'start', '--state', stateDir, '--dsh-repo', join(stateDir, 'dsh'), '--dsh-home', join(stateDir, 'dsh-home'), '--host', hostUrl] })
  return [
    MANAGED_BEGIN,
    '[mcp_servers.dsh_gate]',
    `command = ${quote(process.execPath)}`,
    `args = [${quote(join(runtimeDir, 'packages', 'mcp-server', 'dist', 'cli.js'))}]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 360',
    '',
    '[mcp_servers.dsh_gate.tools.dsh_answer_approval]',
    'approval_mode = "prompt"',
    '',
    '[mcp_servers.dsh_gate.env]',
    `DSH_HOST_URL = ${quote(hostUrl)}`,
    `DSH_HOST_TOKEN_FILE = ${quote(join(stateDir, 'host', 'auth.token'))}`,
    'DSH_WORKER_PROVIDER = "deepseek-official"',
    'DSH_WORKER_MODEL = "deepseek-v4-flash"',
    'DSH_WORKER_REASONING_EFFORT = "high"',
    `DSH_DECISION_POLICY_DIR = ${quote(join(runtimeDir, 'config', 'decision-policies'))}`,
    `DSH_DECISION_POLICY_FILE = ${quote(join(runtimeDir, 'config', 'decision-policies', '2026-08-26.v1.json'))}`,
    `DSH_RUN_JOURNAL_DIR = ${quote(join(stateDir, 'memory', 'runs'))}`,
    `DSH_HOST_LAUNCH = ${quote(launch)}`,
    MANAGED_END,
  ].join('\n')
}

export function replaceManagedBlock(source, block) {
  const begin = source.indexOf(MANAGED_BEGIN)
  const end = source.indexOf(MANAGED_END)
  if ((begin === -1) !== (end === -1) || (begin !== -1 && end < begin)) throw new Error('Codex config contains a malformed dsh-gate managed block')
  if (begin === -1) {
    if (/^\s*\[mcp_servers\.dsh_gate(?:\.|\])/m.test(source)) throw new Error('Codex config already has an unmanaged mcp_servers.dsh_gate section')
    return `${source.trimEnd()}${source.trim() === '' ? '' : '\n\n'}${block}\n`
  }
  const after = end + MANAGED_END.length
  return `${source.slice(0, begin)}${block}${source.slice(after)}`.replace(/^\s+/, source.match(/^\s*/)?.[0] ?? '')
}

export function removeManagedBlock(source) {
  const begin = source.indexOf(MANAGED_BEGIN)
  if (begin === -1) return source
  const end = source.indexOf(MANAGED_END, begin)
  if (end === -1) throw new Error('Codex config contains a malformed dsh-gate managed block')
  return `${source.slice(0, begin)}${source.slice(end + MANAGED_END.length)}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? result.signal ?? `exit ${String(result.status)}`
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
  return result.stdout?.trim() ?? ''
}

async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

async function readJson(path, fallback = undefined) {
  const source = await readFile(path, 'utf8').catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  return source === undefined ? fallback : JSON.parse(source)
}

function isWithin(parent, child) {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function assertRuntimePath(runtimeDir, versionsDir) {
  if (!isWithin(versionsDir, runtimeDir)) throw new Error(`refusing runtime outside ${versionsDir}`)
  const canonicalVersions = await realpath(versionsDir)
  const canonicalRuntime = await realpath(runtimeDir)
  if (!isWithin(canonicalVersions, canonicalRuntime)) throw new Error(`refusing runtime symlink outside ${versionsDir}`)
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60 * 1000) })
  if (!response.ok || response.body === null) throw new Error(`download failed (${response.status}) ${url}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { mode: 0o600 }))
}

function assertSafeArchiveListing(listing) {
  const entries = listing.split('\n').filter(Boolean)
  if (entries.length === 0) throw new Error('bundle archive is empty')
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/')
    if (isAbsolute(entry) || normalized.split('/').includes('..') || !normalized.startsWith('dsh-gate-bundle/')) {
      throw new Error(`unsafe bundle archive entry ${entry}`)
    }
  }
}

async function assertExtractedContainment(root) {
  const canonicalRoot = await realpath(root)
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await realpath(path).catch(() => undefined)
        if (target === undefined || (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${sep}`))) {
          throw new Error(`bundle symlink escapes its payload: ${relative(canonicalRoot, path)}`)
        }
      } else if (entry.isDirectory()) await visit(path)
    }
  }
  await visit(canonicalRoot)
}

async function resolveBundle(options, temporary) {
  if (options.bundle !== undefined) {
    const bundle = resolve(options.bundle)
    const digest = options.sha256 ?? (await readFile(`${bundle}.sha256`, 'utf8').catch(() => undefined))?.trim().split(/\s+/)[0]
    if (!/^[a-f0-9]{64}$/i.test(digest ?? '')) throw new Error('offline/local bundles require --sha256 HEX or a FILE.sha256 sidecar')
    return { bundle, digest: digest.toLowerCase() }
  }
  const version = options.version ?? PACKAGE_VERSION
  const asset = `dsh-gate-runtime-${version}-${hostPlatform()}-${hostArch()}.tar.gz`
  const bundle = join(temporary, asset)
  const checksum = join(temporary, `${asset}.sha256`)
  const base = `${RELEASE_BASE}/v${version}`
  await download(`${base}/${asset}`, bundle)
  await download(`${base}/${asset}.sha256`, checksum)
  const digest = (await readFile(checksum, 'utf8')).trim().split(/\s+/)[0]
  if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error('release checksum is malformed')
  return { bundle, digest: digest.toLowerCase() }
}

function resolvedPaths(options = {}) {
  const installRoot = resolve(options.installDir ?? join(homedir(), '.local', 'share', 'dsh-gate'))
  const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'))
  const skillsDir = resolve(options.skillsDir ?? process.env.CODEX_SKILLS_DIR ?? join(homedir(), '.agents', 'skills'))
  return { installRoot, codexHome, skillsDir, stateDir: join(installRoot, 'state'), versionsDir: join(installRoot, 'versions') }
}

function isOwnedInstallation(value, paths) {
  return value?.schemaVersion === 1 && value?.product === 'dsh-gate' && value?.stateDir === paths.stateDir
}

async function writeSeed({ stateDir, runtimeDir, manifest }) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const dshRepo = join(stateDir, 'dsh')
  const dshHome = join(stateDir, 'dsh-home')
  const gateSha = `release:${manifest.gateCommit}`
  const nodeModules = path => exists(join(path, 'node_modules'))
  const steps = {
    dshBuild: { done: true, sha: manifest.dshCommit },
    gateBuild: { done: true, gateSha },
  }
  if (await nodeModules(dshRepo)) steps.dshInstall = { done: true, sha: manifest.dshCommit }
  if (await nodeModules(runtimeDir)) steps.gateInstall = { done: true, gateSha }
  if (await exists(join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-gate', 'supervisor-tools'))) {
    steps.plugin = { done: true, sha: manifest.dshCommit, profile: 'web', home: dshHome }
  }
  if (await exists(join(runtimeDir, 'packages', 'mcp-server', 'node_modules', '@deepseek-ai', 'dsh-client-connection'))) {
    steps.link = { done: true, target: dshRepo }
  }
  if (await exists(join(dshHome, 'skills', 'dsh-supervised-worker', 'SKILL.md'))) {
    steps.workerSkill = { done: true, gateSha, path: join(dshHome, 'skills', 'dsh-supervised-worker', 'SKILL.md') }
  }
  await atomicWrite(join(stateDir, 'install.json'), `${JSON.stringify({
    schemaVersion: 1,
    stateDir,
    forkUrl: 'https://github.com/yidapan666-creator/deepseek-harness.git',
    pinnedCommit: manifest.dshCommit,
    pinnedBranch: 'codex/mcp-network-client',
    paths: { dshRepo, dshHome, hostTokenFile: join(stateDir, 'host', 'auth.token') },
    versions: { node: process.version, distribution: manifest.version, dshGateCommit: gateSha },
    steps,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`)
}

async function materializeProfileTemplate(payload, stateDir, runtimeDir) {
  const source = join(payload, 'profile')
  const dshHome = join(stateDir, 'dsh-home')
  if (!(await exists(dshHome))) await cp(source, dshHome, { recursive: true, dereference: false, verbatimSymlinks: true })
  const profile = join(dshHome, 'profiles', 'web')
  const manifestPath = join(profile, 'package.json')
  const profileManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  profileManifest.dependencies = {
    ...(profileManifest.dependencies ?? {}),
    '@dsh-gate/supervisor-tools': `link:${join(runtimeDir, 'packages', 'dsh-supervisor-tools')}`,
  }
  await atomicWrite(manifestPath, `${JSON.stringify(profileManifest, null, 2)}\n`)
  const link = join(profile, 'node_modules', '@dsh-gate', 'supervisor-tools')
  await rm(link, { recursive: true, force: true })
  await mkdir(dirname(link), { recursive: true })
  await symlink(join(runtimeDir, 'packages', 'dsh-supervisor-tools'), link, 'dir')
  const workerSource = join(source, 'skills', 'dsh-supervised-worker', 'SKILL.md')
  const workerDestination = join(dshHome, 'skills', 'dsh-supervised-worker', 'SKILL.md')
  await atomicWrite(workerDestination, await readFile(workerSource, 'utf8'))
}

async function prepareOfflineRuntime(runtimeDir, stateDir, dshTarget) {
  for (const required of [
    join(runtimeDir, 'node_modules'),
    join(runtimeDir, 'packages', 'mcp-server', 'node_modules'),
    join(runtimeDir, 'packages', 'dsh-supervisor-tools', 'node_modules'),
    join(dshTarget, 'node_modules'),
  ]) {
    if (!(await exists(required))) throw new Error(`offline bundle is missing dependency tree ${required}`)
  }
  const link = join(runtimeDir, 'packages', 'mcp-server', 'node_modules', '@deepseek-ai', 'dsh-client-connection')
  const target = join(dshTarget, 'packages', 'client', 'connection')
  await rm(link, { recursive: true, force: true })
  await mkdir(dirname(link), { recursive: true })
  await symlink(target, link, 'dir')

  const tokenPath = join(stateDir, 'host', 'auth.token')
  if (!(await exists(tokenPath))) {
    await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 })
    await writeFile(tokenPath, `${randomBytes(32).toString('base64url')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  }
  const tokenStat = await lstat(tokenPath)
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || (tokenStat.mode & 0o077) !== 0) {
    throw new Error(`unsafe Host credential path at ${tokenPath}; expected a mode-0600 regular file`)
  }
}

async function updateCodexConfig(codexHome, block) {
  const path = join(codexHome, 'config.toml')
  const current = await readFile(path, 'utf8').catch(error => error?.code === 'ENOENT' ? '' : Promise.reject(error))
  const updated = replaceManagedBlock(current, block)
  if (updated === current) return
  if (current !== '') await writeFile(`${path}.backup-${Date.now()}`, current, { mode: 0o600 })
  await atomicWrite(path, updated)
}

async function installSkill(runtimeDir, skillsDir, installRoot) {
  run(process.execPath, [join(runtimeDir, 'scripts', 'install-codex-skill.mjs'), '--target', skillsDir, '--force'])
  await atomicWrite(join(skillsDir, 'codex-dsh-supervisor', '.dsh-gate-owner.json'), `${JSON.stringify({ installRoot }, null, 2)}\n`)
}

function runtimeCommon(stateDir) {
  return ['--state', stateDir, '--dsh-repo', join(stateDir, 'dsh'), '--dsh-home', join(stateDir, 'dsh-home')]
}

function invokeHost(runtimeDir, stateDir, hostUrl, action) {
  run(process.execPath, [join(runtimeDir, 'scripts', 'dsh-gate.mjs'), 'host', action, ...runtimeCommon(stateDir), '--host', hostUrl])
}

function smokeRuntime(runtimeDir, stateDir) {
  run(process.execPath, [join(stateDir, 'dsh', 'apps', 'cli', 'lib', 'bin.js'), '--version'], {
    capture: true,
    env: { ...process.env, DSH_HOME: join(stateDir, 'dsh-home') },
  })
  const mcpEntry = pathToFileURL(join(runtimeDir, 'packages', 'mcp-server', 'dist', 'index.js')).href
  run(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(mcpEntry)})`], { capture: true })
}

async function restoreCodexConfig(path, source) {
  if (source === undefined) await rm(path, { force: true })
  else await atomicWrite(path, source)
}

async function prepareRuntime(command, options) {
  const paths = resolvedPaths(options)
  const hostUrl = normalizeHostUrl(options.host)
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ command, ...paths, hostUrl, source: options.bundle ?? `GitHub Release v${options.version ?? PACKAGE_VERSION}`, start: options.start, config: options.config, skill: options.skill }, null, 2)}\n`)
    return
  }
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-gate-setup-'))
  const currentPath = join(paths.installRoot, 'current.json')
  const configPath = join(paths.codexHome, 'config.toml')
  const skillPath = join(paths.skillsDir, 'codex-dsh-supervisor')
  const skillBackup = join(temporary, 'skill-backup')
  const dshHome = join(paths.stateDir, 'dsh-home')
  const profileManifestPath = join(dshHome, 'profiles', 'web', 'package.json')
  const profileLinkPath = join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-gate', 'supervisor-tools')
  const profileManifestBackup = join(temporary, 'profile-package.json')
  const profileLinkBackup = join(temporary, 'profile-supervisor-link')
  const workerSkillPath = join(dshHome, 'skills', 'dsh-supervised-worker', 'SKILL.md')
  const workerSkillBackup = join(temporary, 'worker-skill.md')
  const installMarkerPath = join(paths.stateDir, 'install.json')
  let previous = {}
  let previousOwned = false
  let previousCurrent
  let previousConfig
  let previousInstallMarker
  let hadSkill = false
  let hadDshHome = false
  let hadProfileManifest = false
  let hadProfileLink = false
  let hadWorkerSkill = false
  let hadHostToken = false
  let runtimeDir
  let runtimeBackup
  let dshBackup
  let installedDsh = false
  let installedRuntime = false
  let stoppedPreviousHost = false
  let startedNewHost = false
  let touchedConfig = false
  let touchedSkill = false
  let touchedCurrent = false
  let mutationStarted = false
  try {
    previousCurrent = await readFile(currentPath, 'utf8').catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
    previous = previousCurrent === undefined ? {} : JSON.parse(previousCurrent)
    previousOwned = isOwnedInstallation(previous, paths)
    previousConfig = await readFile(configPath, 'utf8').catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
    hadSkill = await exists(skillPath)
    if (hadSkill) await cp(skillPath, skillBackup, { recursive: true, dereference: false, verbatimSymlinks: true })
    hadDshHome = await exists(dshHome)
    hadProfileManifest = await exists(profileManifestPath)
    hadProfileLink = await exists(profileLinkPath)
    hadWorkerSkill = await exists(workerSkillPath)
    hadHostToken = await exists(join(paths.stateDir, 'host', 'auth.token'))
    if (hadProfileManifest) await cp(profileManifestPath, profileManifestBackup, { dereference: false })
    if (hadProfileLink) await cp(profileLinkPath, profileLinkBackup, { recursive: true, dereference: false, verbatimSymlinks: true })
    if (hadWorkerSkill) await cp(workerSkillPath, workerSkillBackup, { dereference: false })
    previousInstallMarker = await readFile(installMarkerPath, 'utf8').catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))

    const selected = await resolveBundle(options, temporary)
    const actual = await sha256File(selected.bundle)
    if (actual !== selected.digest) throw new Error(`bundle checksum mismatch: expected ${selected.digest}, got ${actual}`)
    const listing = run('tar', ['-tzf', selected.bundle], { capture: true })
    assertSafeArchiveListing(listing)
    const extracted = join(temporary, 'extract')
    await mkdir(extracted)
    run('tar', ['-xzf', selected.bundle, '-C', extracted])
    const payload = join(extracted, 'dsh-gate-bundle')
    await assertExtractedContainment(payload)
    const manifest = validateBundleManifest(JSON.parse(await readFile(join(payload, 'manifest.json'), 'utf8')))
    const runtimeSource = join(payload, 'runtime')
    const dshSource = join(payload, 'dsh')
    if (!(await stat(join(runtimeSource, 'scripts', 'dsh-gate.mjs'))).isFile()) throw new Error('bundle runtime is incomplete')
    if (!(await stat(join(dshSource, 'apps', 'cli', 'lib', 'bin.js'))).isFile()) throw new Error('bundle DSH build is incomplete')

    mutationStarted = true
    await mkdir(paths.versionsDir, { recursive: true, mode: 0o700 })
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 })
    runtimeDir = join(paths.versionsDir, `${manifest.version}-${manifest.gateCommit.slice(0, 12)}`)
    let reuseRuntime = false
    if (await exists(runtimeDir)) {
      if (!options.force) {
        const installedManifest = await readJson(join(runtimeDir, '.dsh-distribution.json'))
        if (!previousOwned || previous.runtimeDir !== runtimeDir || installedManifest?.gateCommit !== manifest.gateCommit || installedManifest?.dshCommit !== manifest.dshCommit) {
          throw new Error(`${runtimeDir} already exists and is not the active matching runtime; use upgrade or --force`)
        }
        reuseRuntime = true
      } else {
        runtimeBackup = `${runtimeDir}.backup-${Date.now()}`
      }
    }

    if (previousOwned && previous.hostManaged === true && typeof previous.runtimeDir === 'string' && typeof previous.hostUrl === 'string' && await exists(previous.runtimeDir)) {
      await assertRuntimePath(previous.runtimeDir, paths.versionsDir)
      invokeHost(previous.runtimeDir, paths.stateDir, previous.hostUrl, 'stop')
      stoppedPreviousHost = true
    }

    if (!reuseRuntime) {
      if (runtimeBackup !== undefined) await rename(runtimeDir, runtimeBackup)
      await rename(runtimeSource, runtimeDir)
      installedRuntime = true
      await atomicWrite(join(runtimeDir, '.dsh-distribution.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    }

    const dshTarget = join(paths.stateDir, 'dsh')
    if (await exists(dshTarget)) {
      const head = run('git', ['rev-parse', 'HEAD'], { cwd: dshTarget, capture: true })
      if (head !== manifest.dshCommit) {
        if (!options.force) throw new Error(`installed DSH ${head} differs from bundle ${manifest.dshCommit}; use upgrade or --force`)
        await mkdir(join(paths.installRoot, 'backups'), { recursive: true, mode: 0o700 })
        dshBackup = join(paths.installRoot, 'backups', `dsh-${head.slice(0, 12)}-${Date.now()}`)
        await rename(dshTarget, dshBackup)
        installedDsh = true
        await rename(dshSource, dshTarget)
      }
    } else {
      await rename(dshSource, dshTarget)
      installedDsh = true
    }

    await materializeProfileTemplate(payload, paths.stateDir, runtimeDir)
    if (manifest.kind === 'offline') await prepareOfflineRuntime(runtimeDir, paths.stateDir, dshTarget)
    await writeSeed({ stateDir: paths.stateDir, runtimeDir, manifest })
    const common = runtimeCommon(paths.stateDir)
    if (manifest.kind === 'online') run(process.execPath, [join(runtimeDir, 'scripts', 'dsh-gate.mjs'), 'bootstrap', ...common])
    smokeRuntime(runtimeDir, paths.stateDir)
    run(process.execPath, [join(runtimeDir, 'scripts', 'dsh-gate.mjs'), 'doctor', ...common])
    if (options.start) {
      startedNewHost = true
      invokeHost(runtimeDir, paths.stateDir, hostUrl, 'start')
      run(process.execPath, [join(runtimeDir, 'scripts', 'dsh-gate.mjs'), 'doctor', ...common, '--live', '--host', hostUrl])
    }
    if (options.skill) {
      touchedSkill = true
      await installSkill(runtimeDir, paths.skillsDir, paths.installRoot)
    }
    if (options.config) {
      touchedConfig = true
      await updateCodexConfig(paths.codexHome, renderCodexBlock({ runtimeDir, stateDir: paths.stateDir, hostUrl }))
    }
    touchedCurrent = true
    await atomicWrite(currentPath, `${JSON.stringify({ schemaVersion: 1, product: 'dsh-gate', version: manifest.version, runtimeDir, stateDir: paths.stateDir, hostUrl, hostManaged: options.start }, null, 2)}\n`)
    await rm(join(paths.installRoot, 'retained.json'), { force: true })
    if (runtimeBackup !== undefined) {
      try { await rm(runtimeBackup, { recursive: true, force: true }) } catch (cleanupError) { process.stderr.write(`[dsh-gate] cleanup warning: could not remove runtime backup: ${cleanupError.message}\n`) }
    }
    process.stdout.write(`[dsh-gate] ${command} complete: ${runtimeDir}\n[dsh-gate] restart Codex, then ask it to use DSH.\n`)
    if (process.env.DEEPSEEK_API_KEY === undefined && !(await exists(join(paths.stateDir, 'dsh-home', '.credentials.yaml')))) {
      process.stdout.write(`[dsh-gate] provider credential not detected; configure it in DSH Web before starting a model task.\n`)
    }
  } catch (error) {
    if (mutationStarted) {
      if (startedNewHost && runtimeDir !== undefined && await exists(runtimeDir)) {
        try { invokeHost(runtimeDir, paths.stateDir, hostUrl, 'stop') } catch (rollbackError) { process.stderr.write(`[dsh-gate] rollback warning: could not stop new Host: ${rollbackError.message}\n`) }
      }
      if (touchedConfig) await restoreCodexConfig(configPath, previousConfig)
      if (touchedCurrent) await restoreCodexConfig(currentPath, previousCurrent)
      if (touchedSkill) {
        await rm(skillPath, { recursive: true, force: true })
        if (hadSkill) await cp(skillBackup, skillPath, { recursive: true, dereference: false, verbatimSymlinks: true })
      }
      if (installedDsh) {
        await rm(join(paths.stateDir, 'dsh'), { recursive: true, force: true })
        if (dshBackup !== undefined) await rename(dshBackup, join(paths.stateDir, 'dsh'))
      }
      if (installedRuntime && runtimeDir !== undefined) await rm(runtimeDir, { recursive: true, force: true })
      if (runtimeBackup !== undefined && runtimeDir !== undefined && await exists(runtimeBackup)) await rename(runtimeBackup, runtimeDir)
      if (!hadDshHome) {
        await rm(dshHome, { recursive: true, force: true })
      } else {
        if (hadProfileManifest) await cp(profileManifestBackup, profileManifestPath, { force: true })
        else await rm(profileManifestPath, { force: true })
        await rm(profileLinkPath, { recursive: true, force: true })
        if (hadProfileLink) {
          await mkdir(dirname(profileLinkPath), { recursive: true })
          await cp(profileLinkBackup, profileLinkPath, { recursive: true, dereference: false, verbatimSymlinks: true })
        }
        if (hadWorkerSkill) await cp(workerSkillBackup, workerSkillPath, { force: true })
        else await rm(workerSkillPath, { force: true })
      }
      if (previousInstallMarker === undefined) await rm(installMarkerPath, { force: true })
      else await atomicWrite(installMarkerPath, previousInstallMarker)
      if (!hadHostToken) await rm(join(paths.stateDir, 'host', 'auth.token'), { force: true })
      if (stoppedPreviousHost && previousOwned && previous.hostManaged === true && typeof previous.runtimeDir === 'string' && typeof previous.hostUrl === 'string' && await exists(previous.runtimeDir)) {
        try { invokeHost(previous.runtimeDir, paths.stateDir, previous.hostUrl, 'start') } catch (rollbackError) { process.stderr.write(`[dsh-gate] rollback warning: could not restart previous Host: ${rollbackError.message}\n`) }
      }
    }
    throw error
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function uninstall(options) {
  const paths = resolvedPaths(options)
  const currentPath = join(paths.installRoot, 'current.json')
  const current = JSON.parse(await readFile(currentPath, 'utf8').catch(error => error?.code === 'ENOENT' ? '{}' : Promise.reject(error)))
  const retainedPath = join(paths.installRoot, 'retained.json')
  const retained = await readJson(retainedPath, {})
  const owned = isOwnedInstallation(current, paths)
  const retainedOwned = isOwnedInstallation(retained, paths)
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ command: 'uninstall', ...paths, purge: options.purge, current }, null, 2)}\n`)
    return
  }
  if (options.purge && !owned && !retainedOwned) throw new Error(`refusing --purge: ${paths.installRoot} has no dsh-gate ownership marker`)
  if (owned && current.hostManaged === true && typeof current.runtimeDir === 'string' && typeof current.hostUrl === 'string' && await exists(current.runtimeDir)) {
    try {
      await assertRuntimePath(current.runtimeDir, paths.versionsDir)
      invokeHost(current.runtimeDir, paths.stateDir, current.hostUrl, 'stop')
    } catch (error) {
      process.stderr.write(`[dsh-gate] uninstall warning: could not stop Host: ${error.message}\n`)
    }
  }
  const configPath = join(paths.codexHome, 'config.toml')
  const config = await readFile(configPath, 'utf8').catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (config !== undefined) await atomicWrite(configPath, removeManagedBlock(config))
  const skill = join(paths.skillsDir, 'codex-dsh-supervisor')
  const owner = JSON.parse(await readFile(join(skill, '.dsh-gate-owner.json'), 'utf8').catch(() => '{}'))
  if (owner.installRoot === paths.installRoot) await rm(skill, { recursive: true, force: true })
  if (options.purge) await rm(paths.installRoot, { recursive: true, force: true })
  else if (owned) {
    await rm(join(paths.installRoot, 'versions'), { recursive: true, force: true })
    await atomicWrite(retainedPath, `${JSON.stringify({ schemaVersion: 1, product: 'dsh-gate', stateDir: paths.stateDir, retainedAt: new Date().toISOString() }, null, 2)}\n`)
    await rm(currentPath, { force: true })
  }
  process.stdout.write(`[dsh-gate] uninstalled${options.purge ? ' and removed retained state' : '; session state was preserved'}\n`)
}

export async function runCli(argv) {
  const parsed = parseArgs(argv)
  if (parsed.command === 'help') {
    process.stdout.write(`${usageText()}\n`)
    return
  }
  if (parsed.command === 'version') {
    process.stdout.write(`${PACKAGE_VERSION}\n`)
    return
  }
  if (parsed.command === 'uninstall') return uninstall(parsed.options)
  return prepareRuntime(parsed.command, parsed.options)
}
