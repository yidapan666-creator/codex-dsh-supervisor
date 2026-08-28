#!/usr/bin/env node
// dsh-gate CLI: deterministic bootstrap/doctor/Host-lifecycle workflow.
//
// Wire the real `io` (fs, child_process, fetch) around the pure library in
// dsh-gate-lib.mjs. Every mutating action is bounded and idempotent; a
// failing phase reports its name, argv, and redacted output — never the
// environment or credentials.

import { spawn, spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_HOST_URL,
  DSH_PINNED_COMMIT,
  formatPhaseFailure,
  hostLaunchArgv,
  parseCliArgs,
  planBootstrap,
  readHostPidFile,
  resolvePaths,
  resolvePnpm,
  runDoctor,
  summarizeDoctor,
  usageText,
  validateCheckout,
  obtainCheckoutCommands,
  linkCommand,
  probePid,
  describeHost,
  DSH_FORK_URL,
  DSH_FORK_BRANCH,
  SUPERVISOR_PROFILE,
  SUPERVISOR_PLUGIN_NAME,
  acquireHostStartLease,
} from './dsh-gate-lib.mjs'

const VERSION = '0.1.0'

// ---------------------------------------------------------------------------
// io wiring
// ---------------------------------------------------------------------------

const io = {
  exists: async (path) => {
    try {
      await lstat(path)
      return true
    } catch {
      return false
    }
  },
  readFile: async (path) => readFile(path, 'utf8'),
  writeFile: async (path, content) => writeFile(path, content, 'utf8'),
  writeFileExclusive: async (path, content) => writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
  rename: async (from, to) => rename(from, to),
  mkdir: async (path) => mkdir(path, { recursive: true }),
  realpath: async (path) => realpath(path),
  lstat: async (path) => lstat(path),
  readlink: async (path) => readlink(path),
  rm: async (path, options = {}) => rm(path, options),
  readJson: async (path) => JSON.parse(await readFile(path, 'utf8')),
  writeJson: async (path, value) => writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8'),
  exec: (command, args, options = {}) => new Promise((resolvePromise) => {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    resolvePromise({
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error === undefined ? undefined : result.error.code,
    })
  }),
  fetch: (url, init) => globalThis.fetch(url, init),
  spawn: (command, args, options) => spawn(command, args, options),
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function log(message) {
  process.stdout.write(`[dsh-gate] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[dsh-gate] ${message}\n`)
  process.exitCode = 1
}

async function runCommand(phase, command, options = {}) {
  const argv = command.argv
  const label = options.label ?? phase.name
  log(`${label}: ${argv.map(argument => /[\s"']/.test(argument) ? JSON.stringify(argument) : argument).join(' ')}`)
  const result = await io.exec(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs,
  })
  if (result.status !== 0) {
    fail(formatPhaseFailure({
      phase: label,
      argv,
      cwd: options.cwd,
      exitCode: result.status,
      output: `${result.stdout}\n${result.stderr}`,
      hint: options.hint,
    }))
    return false
  }
  return true
}

function currentGateSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: paths.root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

async function writeInstallMetadata(paths, steps, gateSha, pnpm) {
  await io.mkdir(paths.stateDir)
  const metadata = {
    schemaVersion: 1,
    stateDir: paths.stateDir,
    forkUrl: DSH_FORK_URL,
    pinnedCommit: DSH_PINNED_COMMIT,
    pinnedBranch: DSH_FORK_BRANCH,
    paths: { dshRepo: paths.dshRepo, dshHome: paths.dshHome },
    versions: {
      node: process.version,
      pnpm: pnpm.version,
      pnpmVia: pnpm.via,
      dshGateCommit: gateSha,
    },
    steps,
    updatedAt: new Date().toISOString(),
  }
  const tmp = `${paths.installJson}.tmp`
  await io.writeJson(tmp, metadata)
  await io.rename(tmp, paths.installJson)
  return metadata
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function runBootstrap({ paths, options, pnpm, gateSha }) {
  log(`pinned DSH fork ${DSH_FORK_URL} @ ${DSH_PINNED_COMMIT}`)
  log(`state dir: ${paths.stateDir}`)
  log(`managed checkout: ${paths.dshRepo}`)
  log(`isolated DSH_HOME: ${paths.dshHome}`)

  // Phase 1: obtain or validate the managed checkout (never mutates an
  // existing checkout).
  const existing = await io.exists(join(paths.dshRepo, '.git'))
  let checkout
  if (existing) {
    checkout = await validateCheckout(paths.dshRepo, io)
    if (!checkout.ok) {
      fail(`existing checkout ${paths.dshRepo} is not usable: ${checkout.problems.join('; ')}`)
      if (options.dryRun) {
        log('DRY RUN continues to show the remaining plan; a real run stops here and never performs destructive recovery (see DEPLOYMENT.md "Clean failure recovery")')
      } else {
        return false
      }
    } else {
      log('checkout: present and valid (exact pinned commit, fork remote, worktree clean)')
    }
  } else {
    checkout = { ok: false, problems: ['checkout absent'] }
    if (!options.dryRun) {
      await io.mkdir(paths.stateDir)
      for (const [command, args] of obtainCheckoutCommands({ dir: paths.dshRepo })) {
        const ok = await runCommand({ name: 'checkout' }, { argv: [command, ...args] }, { cwd: paths.root })
        if (!ok) return false
      }
      log(`checkout: fetched pinned commit ${DSH_PINNED_COMMIT} into ${paths.dshRepo}`)
    }
  }

  const phases = await planBootstrap({ paths, io, force: options.force, pnpm, gateSha, checkout })

  if (options.dryRun) {
    log('DRY RUN — no changes are made. Planned phases:')
    for (const phase of phases) {
      let command
      if (phase.name === 'checkout' && !checkout.ok) {
        command = obtainCheckoutCommands({ dir: paths.dshRepo })
          .map(([cmd, args]) => [cmd, ...args].map(a => /[\s"']/.test(a) ? JSON.stringify(a) : a).join(' '))
          .join(' ; ')
      } else {
        command = phase.argv === undefined ? '(internal)' : phase.argv.map(a => /[\s"']/.test(a) ? JSON.stringify(a) : a).join(' ')
      }
      const suffix = phase.action === 'skip' ? `skip — ${phase.skipReason}` : `run — ${command}${phase.cwd === undefined ? '' : `   (cwd: ${phase.cwd})`}`
      log(`  ${phase.name}: ${suffix}`)
    }
    log('DRY RUN complete.')
    return true
  }

  // Phases 2..N: install/build/link/plugin, each idempotent and bounded.
  // Seed markers from the previous successful run so skipped phases keep
  // their recorded state across re-runs; phases that run overwrite theirs.
  const previous = await io.readJson(paths.installJson).catch(() => undefined)
  const steps = { ...(previous?.steps ?? {}) }
  for (const phase of phases) {
    if (phase.name === 'metadata') continue
    if (phase.action === 'skip') {
      log(`${phase.name}: skip — ${phase.skipReason}`)
      continue
    }
    if (phase.name === 'checkout') continue // already handled above
    let ok
    switch (phase.name) {
      case 'dsh-install': {
        ok = await runCommand(phase, { argv: phase.argv }, { cwd: phase.cwd, hint: 'if the frozen lockfile is out of sync with the pinned commit, the checkout is not the pinned tree' })
        if (ok) steps.dshInstall = { done: true, sha: DSH_PINNED_COMMIT }
        break
      }
      case 'dsh-build': {
        ok = await runCommand(phase, { argv: phase.argv }, { cwd: phase.cwd, timeoutMs: 30 * 60 * 1000, hint: 'DSH build failures usually mean missing build prerequisites; see DEPLOYMENT.md' })
        if (ok) steps.dshBuild = { done: true, sha: DSH_PINNED_COMMIT }
        break
      }
      case 'gate-install': {
        ok = await runCommand(phase, { argv: phase.argv }, { cwd: phase.cwd, hint: 'run `pnpm install` manually for the full error' })
        if (ok) steps.gateInstall = { done: true, gateSha }
        break
      }
      case 'link': {
        const link = linkCommand({ root: paths.root, dshRepo: paths.dshRepo })
        ok = await runCommand(phase, { argv: link.argv }, { cwd: link.cwd })
        if (ok) steps.link = { done: true, target: paths.dshRepo }
        break
      }
      case 'gate-build': {
        ok = await runCommand(phase, { argv: phase.argv }, { cwd: phase.cwd, timeoutMs: 20 * 60 * 1000, hint: 'gate-build requires the network-client link to exist (phase link)' })
        if (ok) steps.gateBuild = { done: true, gateSha }
        break
      }
      case 'plugin': {
        ok = await runCommand(phase, { argv: phase.argv }, {
          cwd: phase.cwd,
          env: { ...process.env, ...phase.env },
          timeoutMs: 10 * 60 * 1000,
          hint: `the ${SUPERVISOR_PROFILE} profile lives under DSH_HOME=${paths.dshHome} — inspect it with: DSH_HOME=${paths.dshHome} ${process.execPath} ${paths.dshBin} plugin --profile ${SUPERVISOR_PROFILE} list`,
        })
        if (ok) steps.plugin = { done: true, sha: DSH_PINNED_COMMIT, profile: SUPERVISOR_PROFILE, home: paths.dshHome }
        break
      }
      default:
        throw new Error(`unhandled phase ${phase.name}`)
    }
    if (!ok) return false
  }

  await writeInstallMetadata(paths, steps, gateSha, pnpm)
  log(`bootstrap complete — metadata at ${paths.installJson}`)
  log(`next: pnpm run doctor   (verify the deployment)`)
  log(`      pnpm host:start   (start the independent DSH Web Host on ${DEFAULT_HOST_URL})`)
  return true
}

async function runDoctorCommand({ paths, options }) {
  const results = await runDoctor({
    paths,
    io,
    live: options.live,
    hostUrl: options.host ?? DEFAULT_HOST_URL,
    readinessSession: options.session,
  })
  const summary = summarizeDoctor(results)
  process.stdout.write(`${summary.text}\n`)
  if (!summary.ok) process.exitCode = 1
}

async function runHost({ paths, options, hostAction }) {
  const hostUrl = options.host ?? DEFAULT_HOST_URL
  const dshBin = paths.dshBin

  if (hostAction === 'status') {
    const record = await readHostPidFile(paths, io)
    const state = record === undefined ? 'none' : await probePid(record.pid, io)
    if (record === undefined || state === 'dead') {
      try {
        const value = await describeHost({ hostUrl, io, timeoutMs: 2000 })
        const owned = record === undefined ? 'no dsh-gate pidfile' : `pidfile pid ${record.pid} is stale`
        log(`${owned}, but a Host is serving ${hostUrl}: hostInstanceId ${value.hostInstanceId}, cwd ${value.cwd} — it is not managed by dsh-gate (stop it yourself)`)
      } catch {
        log(record === undefined
          ? `no host pidfile at ${paths.hostPidFile} — the Host is not managed by dsh-gate, and nothing is serving ${hostUrl}`
          : `pidfile says pid ${record.pid} but no such process — stale record; run 'pnpm host:start'`)
      }
    } else {
      try {
        const value = await describeHost({ hostUrl, io })
        const pidNote = state === 'unknown' ? `pid ${record.pid} (unverifiable via ps) ` : `pid ${record.pid} `
        log(`RUNNING ${pidNote}— ${hostUrl} protocolVersion ${value.protocolVersion}, hostInstanceId ${value.hostInstanceId}, version ${value.version}`)
      } catch (error) {
        log(state === 'unknown'
          ? `pid ${record.pid} unverifiable and ${hostUrl} not responding: ${error instanceof Error ? error.message : String(error)}`
          : `pid ${record.pid} alive but ${hostUrl} not responding: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return true
  }

  if (hostAction === 'stop') {
    const record = await readHostPidFile(paths, io)
    if (record === undefined) {
      log('no host pidfile — nothing to stop (a Host started outside dsh-gate is untouched)')
      return true
    }
    const state = await probePid(record.pid, io)
    if (state === 'dead') {
      log(`pid ${record.pid} is not running — removing stale pidfile`)
      await io.rm(paths.hostPidFile, { force: true })
      return true
    }
    if (state === 'unknown') {
      fail(`cannot verify pid ${record.pid} (ps is unavailable) — refusing to kill blindly`)
      fail('stop the Host process yourself (or remove ' + paths.hostPidFile + ' after confirming it is gone)')
      return false
    }
    const ps = await io.exec('ps', ['-p', String(record.pid), '-o', 'command='])
    const commandLine = ps.stdout.trim()
    if (!commandLine.includes(dshBin) || !commandLine.includes('web')) {
      fail(`refusing to kill pid ${record.pid}: its command line does not match the dsh-gate Host (${commandLine.slice(0, 120)})`)
      return false
    }
    log(`stopping Host pid ${record.pid}`)
    process.kill(record.pid, 'SIGTERM')
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
      const after = await probePid(record.pid, io)
      if (after === 'dead') {
        await io.rm(paths.hostPidFile, { force: true })
        log('Host stopped')
        return true
      }
      if (after === 'unknown') {
        // ps vanished mid-wait; fall back to the port: the Host is ours (we
        // just SIGTERMed it), so a free port means it exited.
        try {
          await describeHost({ hostUrl, io, timeoutMs: 1000 })
        } catch {
          await io.rm(paths.hostPidFile, { force: true })
          log('Host stopped (port released)')
          return true
        }
      }
    }
    fail(`pid ${record.pid} did not exit within 10s of SIGTERM; leaving it running (pidfile kept)`)
    return false
  }

  // host start / host run
  if (!(await io.exists(dshBin))) {
    fail(`no built dsh CLI at ${dshBin} — run 'pnpm bootstrap' first`)
    return false
  }
  const checkout = await validateCheckout(paths.dshRepo, io)
  if (!checkout.ok) {
    fail(`managed checkout is not usable: ${checkout.problems.join('; ')}`)
    return false
  }
  const profileManifest = await io.readJson(paths.profileManifest).catch(() => undefined)
  const bundles = profileManifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(SUPERVISOR_PLUGIN_NAME)) {
    fail(`${SUPERVISOR_PLUGIN_NAME} is not installed in the ${SUPERVISOR_PROFILE} profile — run 'pnpm bootstrap' first`)
    return false
  }

  const argv = hostLaunchArgv({ dshBin, hostUrl })
  if (options.dryRun) {
    log(`DRY RUN — host would be launched ${hostAction === 'run' ? 'in the foreground' : 'detached'} with:`)
    log(`  ${argv.join(' ')}`)
    log(`  env DSH_HOME=${paths.dshHome}, cwd ${paths.root}, ${hostAction === 'run' ? 'attached stdio' : `detached, stdio -> ${paths.hostLogFile}`}`)
    log(`  url ${hostUrl}`)
    return true
  }

  await io.mkdir(paths.hostDir)
  const releaseStartLease = await acquireHostStartLease(paths, io)
  let startLeaseHeld = true
  const releaseLease = async () => {
    if (!startLeaseHeld) return
    startLeaseHeld = false
    await releaseStartLease()
  }
  try {
    const record = await readHostPidFile(paths, io)
    const state = record === undefined ? 'none' : await probePid(record.pid, io)
    if (state === 'alive' || state === 'unknown') {
      // A recorded pid is present. If it is verifiably ours and the URL
      // responds, it is already running. If ps is unavailable but the URL
      // responds, treat the recorded pid as ours (the pidfile is the only
      // writer of that file) and report already-running.
      try {
        const value = await describeHost({ hostUrl, io })
        const pidNote = state === 'unknown' ? `pid ${record.pid} (unverifiable via ps) ` : `pid ${record.pid} `
        log(`Host already running ${pidNote}— ${hostUrl} hostInstanceId ${value.hostInstanceId}`)
        return true
      } catch {
        if (state === 'alive') {
          fail(`pidfile says pid ${record.pid} is alive but ${hostUrl} does not respond; stop it with 'pnpm host:stop' before starting again`)
          return false
        }
        log(`pid ${record.pid} is unverifiable and ${hostUrl} does not respond — treating the pidfile as stale`)
      }
    }
    if (record !== undefined) {
      log(`clearing stale host pidfile (pid ${record.pid} not running)`)
      await io.rm(paths.hostPidFile, { force: true })
    }

    // Refuse to shadow a Host this checkout does not manage: the port is
    // already served (the spawned instance would die with EADDRINUSE).
    try {
      const foreign = await describeHost({ hostUrl, io, timeoutMs: 2000 })
      fail(`a Host is already serving ${hostUrl} (hostInstanceId ${foreign.hostInstanceId}, cwd ${foreign.cwd}) but no dsh-gate pidfile owns it`)
      fail(`stop that Host yourself or start on another port, for example: node scripts/dsh-gate.mjs host start --host http://127.0.0.1:18080`)
      return false
    } catch {
      // port free — proceed
    }

    if (hostAction === 'run') {
      const child = io.spawn(argv[0], argv.slice(1), {
        cwd: paths.root,
        env: { ...process.env, DSH_HOME: paths.dshHome },
        detached: false,
        stdio: 'inherit',
      })
      const pid = await new Promise((resolvePromise, rejectPromise) => {
        child.once('error', rejectPromise)
        child.once('spawn', () => resolvePromise(child.pid))
      })
      try {
        const startedAt = new Date().toISOString()
        await io.writeJson(paths.hostPidFile, { pid, argv, startedAt, url: hostUrl, dshHome: paths.dshHome, supervised: true })
        await releaseLease()
      } catch (error) {
        child.kill('SIGTERM')
        throw error
      }
      log(`Host attached as pid ${pid}; external process supervisor owns restart policy`)
      let terminating = false
      const forward = (signal) => {
        terminating = true
        if (!child.killed) child.kill(signal)
      }
      const onTerm = () => forward('SIGTERM')
      const onInt = () => forward('SIGINT')
      process.once('SIGTERM', onTerm)
      process.once('SIGINT', onInt)
      const result = await new Promise(resolvePromise => {
        child.once('exit', (code, signal) => resolvePromise({ code, signal }))
      })
      process.removeListener('SIGTERM', onTerm)
      process.removeListener('SIGINT', onInt)
      const current = await readHostPidFile(paths, io)
      if (current?.pid === pid) await io.rm(paths.hostPidFile, { force: true })
      if (terminating) return true
      if (result.code === 0) return true
      fail(`attached Host exited unexpectedly (${result.signal ?? `code ${String(result.code)}`}); the process supervisor may restart it`)
      return false
    }

    await io.mkdir(paths.logsDir)
    const logFd = await openAppend(paths.hostLogFile)
    const child = io.spawn(argv[0], argv.slice(1), {
      cwd: paths.root,
      env: { ...process.env, DSH_HOME: paths.dshHome },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    const pid = await new Promise((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise)
      child.once('spawn', () => {
        child.unref()
        resolvePromise(child.pid)
      })
    })
    const startedAt = new Date().toISOString()
    await io.writeJson(paths.hostPidFile, { pid, argv, startedAt, url: hostUrl, dshHome: paths.dshHome })
    log(`Host launched pid ${pid} — log: ${paths.hostLogFile}`)
    log(`waiting for ${hostUrl}/api/host.describe …`)
    const deadline = Date.now() + 30_000
    let value
    while (Date.now() < deadline) {
      try {
        value = await describeHost({ hostUrl, io, timeoutMs: 3000 })
        break
      } catch {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1000))
      }
    }
    if (value === undefined) {
      fail(`Host pid ${pid} did not become reachable at ${hostUrl} within 30s; see ${paths.hostLogFile}`)
      return false
    }
    log(`Host ready — protocolVersion ${value.protocolVersion}, hostInstanceId ${value.hostInstanceId}, version ${value.version}`)
    log(`Web UI: ${hostUrl} (the Host is independent of MCP; 'pnpm host:stop' stops it, MCP never does)`)
    return true
  } finally {
    await releaseLease()
  }
}

async function openAppend(path) {
  const { open } = await import('node:fs/promises')
  return (await open(path, 'a')).createWriteStream({ autoClose: true })
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

let parsed
try {
  parsed = parseCliArgs(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`[dsh-gate] ${error instanceof Error ? error.message : String(error)}\n\n${usageText()}\n`)
  process.exit(2)
}

const { command, hostAction, options } = parsed
if (command === 'help' || options.help) {
  process.stdout.write(`${usageText()}\n`)
  process.exit(0)
}
if (command === 'version' || options.version) {
  process.stdout.write(`dsh-gate ${VERSION}\n`)
  process.exit(0)
}

const paths = resolvePaths({
  root: fileURLToPath(new URL('..', import.meta.url)),
  state: options.state,
  dshRepo: options.dshRepo,
  dshHome: options.dshHome,
})

let ok = false
try {
  if (command === 'bootstrap') {
    const pnpm = await resolvePnpm(io)
    const gateSha = currentGateSha()
    ok = await runBootstrap({ paths, options, pnpm, gateSha })
  } else if (command === 'doctor') {
    ok = await runDoctorCommand({ paths, options })
    ok = process.exitCode !== 1
  } else {
    ok = await runHost({ paths, options, hostAction })
  }
} catch (error) {
  fail(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`)
  ok = false
}
if (!ok) process.exit(1)
