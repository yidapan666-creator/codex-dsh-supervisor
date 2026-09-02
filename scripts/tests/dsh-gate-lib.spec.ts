// Focused unit tests for the dsh-gate bootstrap/doctor/host library.
// No network, no real git, no real filesystem: everything goes through fakes.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST_URL,
  DEFAULT_STATE_DIR_NAME,
  DSH_FORK_BRANCH,
  DSH_FORK_URL,
  DSH_PINNED_COMMIT,
  EXPECTED_GATE_BUILD_ID,
  checkLiveHost,
  checkGatePlugin,
  checkSessionModels,
  formatOutputTail,
  formatPhaseFailure,
  hostIsAlive,
  hostStartPidDecision,
  hostLaunchArgv,
  isPlaceholderVersion,
  probePid,
  linkCommand,
  linkTargetMatches,
  normalizeRemoteUrl,
  obtainCheckoutCommands,
  packageManagerBoundaryEnv,
  parseCliArgs,
  planBootstrap,
  redactOutput,
  remoteMatchesFork,
  resolvePaths,
  resolveHostStatePaths,
  readHostPidFile,
  runDoctor,
  summarizeDoctor,
  validateCheckout,
  acquireHostStartLease,
} from '../dsh-gate-lib.mjs'

const PIN = DSH_PINNED_COMMIT
const ROOT = '/repo/dsh-gate'

describe('package-manager boundary', () => {
  it('drops a stale caller npm_execpath without mutating other environment values', () => {
    const source = { npm_execpath: '/root/pnpm-11.19.cjs', PATH: '/bin', DSH_HOME: '/state/home' }
    const isolated = packageManagerBoundaryEnv(source)

    expect(isolated).toEqual({ PATH: '/bin', DSH_HOME: '/state/home' })
    expect(source.npm_execpath).toBe('/root/pnpm-11.19.cjs')
  })
})

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function makeFakeIo(overrides = {}) {
  const files = new Map(Object.entries(overrides.files ?? {}))
  const execHandlers = overrides.exec ?? {}
  const fetchHandler = overrides.fetch
  return {
    files,
    exists: async (path) => files.has(path),
    readFile: async (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return typeof value === 'string' ? value : JSON.stringify(value)
    },
    writeFile: async (path, content) => { files.set(path, content) },
    writeFileExclusive: async (path, content) => {
      if (files.has(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' })
      files.set(path, content)
    },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from) },
    mkdir: async () => {},
    realpath: async (path) => overrides.realpath?.(path) ?? path,
    lstat: async (path) => ({ isSymbolicLink: () => overrides.symlinkPaths?.includes(path) ?? false }),
    readlink: async () => '',
    rm: async (path) => { files.delete(path) },
    readJson: async (path) => JSON.parse(await (typeof files.get(path) === 'string' ? files.get(path) : JSON.stringify(files.get(path)))),
    writeJson: async (path, value) => { files.set(path, value) },
    exec: async (command, args) => {
      const key = [command, ...args].join(' ')
      const handler = execHandlers[key]
      if (handler !== undefined) return typeof handler === 'function' ? handler() : handler
      throw new Error(`unexpected exec: ${key}`)
    },
    fetch: async (url, init) => {
      if (fetchHandler === undefined) throw new Error(`unexpected fetch: ${url}`)
      return fetchHandler(url, init)
    },
  }
}

function gitExecFixture({ head = PIN, remotes = [`${DSH_FORK_URL} (fetch)`, `${DSH_FORK_URL} (push)`], porcelain = '' } = {}) {
  return {
    [`git rev-parse HEAD`]: { status: 0, stdout: `${head}\n`, stderr: '' },
    [`git remote -v`]: { status: 0, stdout: remotes.map((url, index) => `origin${index === 1 ? '2' : ''}\t${url}`).join('\n') + '\n', stderr: '' },
    [`git status --porcelain`]: { status: 0, stdout: porcelain, stderr: '' },
  }
}

function pathsFor(overrides = {}) {
  return resolvePaths({ root: ROOT, ...overrides })
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

describe('parseCliArgs', () => {
  it('parses bootstrap with flags and overrides', () => {
    const { command, options } = parseCliArgs(['bootstrap', '--dry-run', '--state', '/tmp/state', '--dsh-repo', '/tmp/dsh'])
    expect(command).toBe('bootstrap')
    expect(options.dryRun).toBe(true)
    expect(options.state).toBe('/tmp/state')
    expect(options.dshRepo).toBe('/tmp/dsh')
    expect(options.force).toBe(false)
  })

  it('parses inline --flag=value forms', () => {
    const { options } = parseCliArgs(['doctor', '--state=/tmp/s', '--live', '--session', 'session-1'])
    expect(options.state).toBe('/tmp/s')
    expect(options.live).toBe(true)
    expect(options.session).toBe('session-1')
  })

  it('parses host actions', () => {
    const { command, hostAction, options } = parseCliArgs(['host', 'start', '--host', 'http://127.0.0.1:9999'])
    expect(command).toBe('host')
    expect(hostAction).toBe('start')
    expect(options.host).toBe('http://127.0.0.1:9999')
    expect(parseCliArgs(['host', 'run']).hostAction).toBe('run')
  })

  it('rejects unknown options', () => {
    expect(() => parseCliArgs(['bootstrap', '--nope'])).toThrow(/unknown option --nope/)
  })

  it('rejects missing host action', () => {
    expect(() => parseCliArgs(['host'])).toThrow(/host needs an action/)
  })

  it('rejects unknown commands and stray positionals', () => {
    expect(() => parseCliArgs(['frobnicate'])).toThrow(/unknown command/)
    expect(() => parseCliArgs(['doctor', 'extra'])).toThrow(/unexpected argument/)
  })

  it('accepts --help and --version without a command', () => {
    expect(parseCliArgs(['--help']).command).toBe('help')
    expect(parseCliArgs(['--version']).command).toBe('version')
  })
})

describe('resolvePaths', () => {
  it('derives the gitignored state layout from the repo root', () => {
    const paths = pathsFor()
    expect(paths.stateDir).toBe(`${ROOT}/${DEFAULT_STATE_DIR_NAME}`)
    expect(paths.dshRepo).toBe(`${ROOT}/${DEFAULT_STATE_DIR_NAME}/dsh`)
    expect(paths.dshHome).toBe(`${ROOT}/${DEFAULT_STATE_DIR_NAME}/dsh-home`)
    expect(paths.hostPidFile).toBe(`${ROOT}/${DEFAULT_STATE_DIR_NAME}/host/host.pid`)
    expect(paths.hostStartLockFile).toBe(`${ROOT}/${DEFAULT_STATE_DIR_NAME}/host/host.start.lock`)
    expect(paths.installJson).toBe(`${ROOT}/${DEFAULT_STATE_DIR_NAME}/install.json`)
  })

  it('honors explicit overrides', () => {
    const paths = pathsFor({ state: '/s', dshRepo: '/d', dshHome: '/h' })
    expect(paths.stateDir).toBe('/s')
    expect(paths.dshRepo).toBe('/d')
    expect(paths.dshHome).toBe('/h')
  })
})

describe('resolveHostStatePaths', () => {
  it('isolates pid, startup lease, and log state by Host port', () => {
    const base = pathsFor()
    const port8080 = resolveHostStatePaths(base, 'http://127.0.0.1:8080')
    const port18080 = resolveHostStatePaths(base, 'http://127.0.0.1:18080')
    expect(port8080.hostPidFile).not.toBe(port18080.hostPidFile)
    expect(port8080.hostStartLockFile).not.toBe(port18080.hostStartLockFile)
    expect(port8080.hostLogFile).not.toBe(port18080.hostLogFile)
    expect(port18080.hostPidFile).toContain('http-127.0.0.1-18080.pid')
  })

  it('only adopts a legacy pid record for its exact Host origin', async () => {
    const base = pathsFor()
    const io = makeFakeIo({ files: {
      [base.hostPidFile]: JSON.stringify({ pid: 42, url: 'http://127.0.0.1:18080' }),
    } })
    const port8080 = resolveHostStatePaths(base, 'http://127.0.0.1:8080')
    const port18080 = resolveHostStatePaths(base, 'http://127.0.0.1:18080')
    await expect(readHostPidFile(port8080, io, 'http://127.0.0.1:8080')).resolves.toBeUndefined()
    await expect(readHostPidFile(port18080, io, 'http://127.0.0.1:18080')).resolves.toMatchObject({
      pid: 42,
      pidFile: base.hostPidFile,
    })
  })
})

// ---------------------------------------------------------------------------
// fork identity
// ---------------------------------------------------------------------------

describe('remoteMatchesFork', () => {
  it('matches the pinned fork in https and ssh spellings', () => {
    expect(remoteMatchesFork(DSH_FORK_URL)).toBe(true)
    expect(remoteMatchesFork('https://github.com/yidapan666-creator/deepseek-harness.git')).toBe(true)
    expect(remoteMatchesFork('git@github.com:yidapan666-creator/deepseek-harness.git')).toBe(true)
  })

  it('rejects upstream, other forks, and local paths', () => {
    expect(remoteMatchesFork('https://github.com/deepseek-ai/deepseek-harness.git')).toBe(false)
    expect(remoteMatchesFork('https://github.com/someone-else/deepseek-harness.git')).toBe(false)
    expect(remoteMatchesFork('/Users/me/deepseek-harness')).toBe(false)
    expect(remoteMatchesFork('file:///tmp/deepseek-harness')).toBe(false)
    expect(remoteMatchesFork('https://evilgithub.com/yidapan666-creator/deepseek-harness.git')).toBe(false)
    expect(remoteMatchesFork('https://github.com.evil.example/yidapan666-creator/deepseek-harness.git')).toBe(false)
  })

  it('normalizes trailing .git and slashes', () => {
    expect(normalizeRemoteUrl('https://github.com/a/b.git/')).toBe('https://github.com/a/b')
  })
})

describe('isPlaceholderVersion', () => {
  it('accepts a real release version', () => {
    expect(isPlaceholderVersion('0.1.0-rc.8')).toBe(false)
  })

  it('rejects empty, sentinel, and template versions', () => {
    for (const bad of ['', '   ', '0.0.0', 'unknown', 'dev', 'placeholder', '{{version}}', '${VERSION}', '<version>', null, undefined, 42]) {
      expect(isPlaceholderVersion(bad)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// checkout validation and acquisition
// ---------------------------------------------------------------------------

describe('validateCheckout', () => {
  it('accepts a clean checkout at the pinned commit with the fork remote', async () => {
    const io = makeFakeIo({ files: { '/d/.git': 'dir' }, exec: gitExecFixture() })
    const result = await validateCheckout('/d', io)
    expect(result.ok).toBe(true)
    expect(result.details.head).toBe(PIN)
  })

  it('refuses both untracked files and tracked changes', async () => {
    const io = makeFakeIo({
      files: { '/d/.git': 'dir' },
      exec: gitExecFixture({ porcelain: '?? untracked-thing/\n M packages/x/src/a.ts\n' }),
    })
    const result = await validateCheckout('/d', io)
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toMatch(/tracked file\(s\) differ/)
    expect(result.problems.join(' ')).toMatch(/untracked path\(s\) are present/)
    expect(result.details.untracked).toBe(1)
  })

  it('refuses a mismatched HEAD', async () => {
    const io = makeFakeIo({ files: { '/d/.git': 'dir' }, exec: gitExecFixture({ head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }) })
    const result = await validateCheckout('/d', io)
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toMatch(/HEAD is deadbeef/)
  })

  it('refuses a checkout without the fork remote', async () => {
    const io = makeFakeIo({
      files: { '/d/.git': 'dir' },
      exec: gitExecFixture({ remotes: ['https://github.com/deepseek-ai/deepseek-harness.git (fetch)'] }),
    })
    const result = await validateCheckout('/d', io)
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toMatch(/no git remote matches the pinned fork/)
  })

  it('refuses a non-git directory', async () => {
    const io = makeFakeIo({ files: {} })
    const result = await validateCheckout('/d', io)
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toMatch(/not a git repository/)
  })
})

describe('obtainCheckoutCommands', () => {
  it('fetches only the pinned commit by SHA, never a branch', () => {
    const commands = obtainCheckoutCommands({ dir: '/state/dsh' })
    const flat = commands.map(([cmd, args]) => [cmd, ...args].join(' ')).join(' ; ')
    expect(flat).toContain(`git -C /state/dsh fetch --depth 1 origin ${PIN}`)
    expect(flat).toContain('checkout --detach FETCH_HEAD')
    expect(flat).toContain(`remote add origin ${DSH_FORK_URL}`)
    expect(flat).not.toContain(DSH_FORK_BRANCH)
  })
})

// ---------------------------------------------------------------------------
// link reuse
// ---------------------------------------------------------------------------

describe('link', () => {
  it('reuses scripts/link-local-dsh.mjs with the managed checkout path', () => {
    const paths = pathsFor()
    const command = linkCommand({ root: paths.root, dshRepo: paths.dshRepo })
    expect(command.argv[0]).toBe(process.execPath)
    expect(command.argv[1]).toContain('link-local-dsh.mjs')
    expect(command.argv[2]).toBe(paths.dshRepo)
    expect(command.cwd).toBe(paths.root)
  })

  it('detects whether the link already resolves to the checkout', async () => {
    const io = makeFakeIo({
      realpath: (path) => path === '/repo/dsh-gate/packages/mcp-server/node_modules/@deepseek-ai/dsh-client-connection'
        ? '/d/packages/client/connection'
        : path,
    })
    expect(await linkTargetMatches({ linkPath: '/repo/dsh-gate/packages/mcp-server/node_modules/@deepseek-ai/dsh-client-connection', dshRepo: '/d', io })).toBe(true)
    const io2 = makeFakeIo({ realpath: (path) => path })
    expect(await linkTargetMatches({ linkPath: '/repo/dsh-gate/packages/mcp-server/node_modules/@deepseek-ai/dsh-client-connection', dshRepo: '/d', io: io2 })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// bootstrap planning
// ---------------------------------------------------------------------------

describe('planBootstrap', () => {
  const checkoutOk = { ok: true, problems: [], details: { head: PIN, remotes: [DSH_FORK_URL], trackedChanges: 0, untracked: 0 } }

  it('plans every phase to run on a fresh state', async () => {
    const paths = pathsFor()
    const io = makeFakeIo({
      exec: { 'git rev-parse HEAD': { status: 0, stdout: `${PIN}\n`, stderr: '' } },
    })
    const phases = await planBootstrap({ paths, io, force: false, pnpm: { argv: ['pnpm'], via: 'path', version: '11.19.0' }, gateSha: 'g1', checkout: { ok: false, problems: ['absent'] } })
    expect(phases.map(p => [p.name, p.action])).toEqual([
      ['checkout', 'run'],
      ['dsh-install', 'run'],
      ['dsh-build', 'run'],
      ['gate-install', 'run'],
      ['link', 'run'],
      ['gate-build', 'run'],
      ['plugin', 'run'],
      ['worker-skill', 'run'],
      ['metadata', 'run'],
    ])
  })

  it('skips current phases when markers match and outputs exist', async () => {
    const paths = pathsFor()
    const files = {
      [paths.installJson]: {
        steps: {
          dshInstall: { done: true, sha: PIN },
          dshBuild: { done: true, sha: PIN },
          gateInstall: { done: true, gateSha: 'g1' },
          gateBuild: { done: true, gateSha: 'g1' },
          plugin: { done: true, sha: PIN },
        },
      },
      [`${paths.dshRepo}/node_modules`]: 'dir',
      [paths.dshBin]: 'js',
      [paths.webDistIndex]: 'html',
      [paths.dshConnectionLib]: 'js',
      [`${paths.root}/node_modules`]: 'dir',
      [paths.mcpServerDistCli]: 'js',
      [paths.profileManifest]: { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-gate/supervisor-tools'] } } },
      [paths.workerSkillSource]: 'worker skill',
      [paths.workerSkillDestination]: 'worker skill',
    }
    const io = makeFakeIo({
      files,
      realpath: (path) => path === paths.linkPath ? `${paths.dshRepo}/packages/client/connection` : path,
    })
    const phases = await planBootstrap({ paths, io, force: false, pnpm: { argv: ['pnpm'], via: 'path', version: '11.19.0' }, gateSha: 'g1', checkout: checkoutOk })
    const skipped = phases.filter(p => p.action === 'skip').map(p => p.name)
    expect(skipped).toContain('dsh-install')
    expect(skipped).toContain('dsh-build')
    expect(skipped).toContain('gate-install')
    expect(skipped).toContain('link')
    expect(skipped).toContain('gate-build')
    expect(skipped).toContain('plugin')
    expect(skipped).toContain('worker-skill')
  })

  it('--force re-runs every build/install phase', async () => {
    const paths = pathsFor()
    const files = { [paths.installJson]: { steps: { dshInstall: { done: true, sha: PIN }, dshBuild: { done: true, sha: PIN }, gateInstall: { done: true, gateSha: 'g1' }, gateBuild: { done: true, gateSha: 'g1' }, plugin: { done: true, sha: PIN } } } }
    const io = makeFakeIo({ files, realpath: (path) => path })
    const phases = await planBootstrap({ paths, io, force: true, pnpm: { argv: ['pnpm'], via: 'path', version: '11.19.0' }, gateSha: 'g1', checkout: checkoutOk })
    for (const name of ['dsh-install', 'dsh-build', 'gate-install', 'gate-build', 'plugin', 'worker-skill']) {
      expect(phases.find(p => p.name === name).action).toBe('run')
    }
  })

  it('never reuses workspace install/build markers for a dirty development tree', async () => {
    const paths = pathsFor()
    const files = {
      [paths.installJson]: { steps: {
        gateInstall: { done: true, gateSha: 'g1-dirty' }, gateBuild: { done: true, gateSha: 'g1-dirty' },
      } },
      [`${paths.root}/node_modules`]: 'dir',
      [paths.mcpServerDistCli]: 'js',
    }
    const phases = await planBootstrap({
      paths, io: makeFakeIo({ files }), force: false,
      pnpm: { argv: ['pnpm'], via: 'path', version: '11.19.0' }, gateSha: 'g1-dirty', checkout: checkoutOk,
    })
    expect(phases.find(phase => phase.name === 'gate-install')?.action).toBe('run')
    expect(phases.find(phase => phase.name === 'gate-build')?.action).toBe('run')
  })

  it('isolates the plugin phase to the project-local DSH_HOME', async () => {
    const paths = pathsFor()
    const io = makeFakeIo({})
    const phases = await planBootstrap({ paths, io, force: false, pnpm: { argv: ['pnpm'], via: 'path', version: '11.19.0' }, gateSha: 'g1', checkout: checkoutOk })
    const plugin = phases.find(p => p.name === 'plugin')
    expect(plugin.env.DSH_HOME).toBe(paths.dshHome)
    expect(plugin.argv).toContain('plugin')
    expect(plugin.argv).toContain('--profile')
    expect(plugin.argv).toContain('web')
    expect(plugin.argv).toContain(paths.pluginPath)
  })
})

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe('runDoctor', () => {
  function goodEnv({ live = false, hostValue, gateValue } = {}) {
    const paths = pathsFor()
    const files = {
      [paths.installJson]: { pinnedCommit: PIN, forkUrl: DSH_FORK_URL, updatedAt: 'now' },
      [`${paths.dshRepo}/.git`]: 'dir',
      [paths.dshBin]: 'js',
      [paths.dshConnectionLib]: 'js',
      [paths.webDistIndex]: 'html',
      [paths.mcpServerDistCli]: 'js',
      [paths.profileManifest]: { dependencies: { '@dsh-gate/supervisor-tools': 'link:...' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-gate/supervisor-tools'] } } },
      [`${paths.pluginPath}/dist/index.js`]: 'js',
      [`${paths.pluginPath}/cordis.patch.yml`]: 'maxDepth: 1\nmaxDepth: 1\ndirectChildToolNames:\n  - subagent\n  - subagent_fork\n',
      [paths.workerSkillSource]: 'worker skill',
      [paths.workerSkillDestination]: 'worker skill',
    }
    const io = makeFakeIo({
      files,
      exec: {
        ...gitExecFixture(),
        [`${process.execPath} --check ${paths.mcpServerDistCli}`]: { status: 0, stdout: '', stderr: '' },
      },
      realpath: (path) => path === paths.linkPath ? `${paths.dshRepo}/packages/client/connection` : path,
      fetch: hostValue === undefined ? undefined : async (url) => ({
        ok: true,
        json: async () => url.endsWith('/api/dsh-gate.describe')
          ? gateValue ?? {
              schemaVersion: 1, gateProtocolVersion: 1, pluginName: '@dsh-gate/supervisor-tools',
              pluginVersion: '0.1.0', buildId: EXPECTED_GATE_BUILD_ID, workerProtocolVersion: 2,
              capabilities: [
                'idempotent-admission-v1', 'durable-before-execute-v1', 'recovery-capsule-v1', 'run-tree-token-budget-v1',
                'crash-durable-token-reservations-v1', 'host-git-baseline-v1', 'direct-child-authority-v1', 'strict-handoff-v1', 'bearer-auth-v1',
              ],
            }
          : { type: 'server-response', rpcId: 'x', result: { ok: true, value: hostValue } },
      }),
    })
    return { paths, io }
  }

  it('passes every check on a healthy deployment', async () => {
    const { paths, io } = goodEnv({ live: true, hostValue: { protocolVersion: 1, hostInstanceId: 'inst-1', version: '0.1.0-rc.8' } })
    const results = await runDoctor({ paths, io, live: true, hostUrl: DEFAULT_HOST_URL })
    for (const result of results) expect(result.ok, result.name).toBe(true)
    const summary = summarizeDoctor(results)
    expect(summary.ok).toBe(true)
  })

  it('fails when install metadata is missing', async () => {
    const paths = pathsFor()
    const io = makeFakeIo({})
    const results = await runDoctor({ paths, io })
    expect(results.find(r => r.name === 'install metadata').ok).toBe(false)
  })

  it('fails when the installed supervisor patch omits native delegation depth enforcement', async () => {
    const { paths, io } = goodEnv()
    io.readFile = async path => path === `${paths.pluginPath}/cordis.patch.yml`
      ? 'directChildToolNames:\n  - subagent\n'
      : ''
    const results = await runDoctor({ paths, io })
    expect(results.find(r => r.name === 'supervisor plugin / profile')).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/depth caps/),
    })
  })

  it('fails on a dirty managed checkout', async () => {
    const { paths, io } = goodEnv()
    io.files.set(`${paths.dshRepo}/.git`, 'dir')
    io.exec = async (command, args) => {
      const key = [command, ...args].join(' ')
      if (key === 'git status --porcelain') return { status: 0, stdout: ' M tracked.ts\n', stderr: '' }
      if (key === 'git rev-parse HEAD') return { status: 0, stdout: `${PIN}\n`, stderr: '' }
      if (key === 'git remote -v') return { status: 0, stdout: `${DSH_FORK_URL} (fetch)\n`, stderr: '' }
      throw new Error(`unexpected exec: ${key}`)
    }
    const results = await runDoctor({ paths, io })
    expect(results.find(r => r.name === 'managed checkout').ok).toBe(false)
  })

  it('rejects a live Host with a placeholder version', async () => {
    const { paths, io } = goodEnv({ live: true, hostValue: { protocolVersion: 1, hostInstanceId: 'inst-1', version: '0.0.0' } })
    const results = await runDoctor({ paths, io, live: true })
    expect(results.find(r => r.name === 'live Host').ok).toBe(false)
  })

  it('rejects a live Host whose supervisor plugin is stale or incomplete', async () => {
    const { paths, io } = goodEnv({
      live: true,
      hostValue: { protocolVersion: 1, hostInstanceId: 'inst-1', version: '0.1.0-rc.8' },
      gateValue: {
        schemaVersion: 1, gateProtocolVersion: 1, pluginName: '@dsh-gate/supervisor-tools',
        pluginVersion: 'old', buildId: 'old', workerProtocolVersion: 2, capabilities: [],
      },
    })
    const results = await runDoctor({ paths, io, live: true })
    expect(results.find(r => r.name === 'live Host')?.ok).toBe(true)
    expect(results.find(r => r.name === 'live supervisor plugin')).toMatchObject({ ok: false })
  })

  it('treats unrelated provider catalog failures as advisory when the selected route is routable', async () => {
    const { paths, io } = goodEnv()
    io.fetch = async (url) => ({
      ok: true,
      json: async () => url.endsWith('/api/dsh-gate.describe')
        ? {
            schemaVersion: 1, gateProtocolVersion: 1, pluginName: '@dsh-gate/supervisor-tools',
            pluginVersion: '0.1.0', buildId: EXPECTED_GATE_BUILD_ID, workerProtocolVersion: 2,
            capabilities: [
              'idempotent-admission-v1', 'durable-before-execute-v1', 'recovery-capsule-v1', 'run-tree-token-budget-v1',
              'crash-durable-token-reservations-v1', 'host-git-baseline-v1', 'direct-child-authority-v1', 'strict-handoff-v1', 'bearer-auth-v1',
            ],
          }
        : ({ type: 'server-response', rpcId: 'x', result: { ok: true, value:
          url.endsWith('/api/host.describe')
          ? { protocolVersion: 1, hostInstanceId: 'inst-1', version: '0.1.0-rc.8' }
          : {
              current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
              routable: true,
              failures: [{ provider: 'unconfigured-provider', message: 'catalog unavailable' }],
            },
        } }),
    })
    const results = await runDoctor({
      paths, io, live: true, hostUrl: DEFAULT_HOST_URL, readinessSession: 'session-1',
    })
    expect(results.find(r => r.name === 'provider/model routing')).toMatchObject({ ok: true })
    expect(results.find(r => r.name === 'provider/model routing').detail).toMatch(/1 unrelated provider catalog warning/)
  })

  it('reports an unreachable live Host', async () => {
    const { paths, io } = goodEnv({ live: true })
    const results = await runDoctor({ paths, io, live: true })
    const live = results.find(r => r.name === 'live Host')
    expect(live.ok).toBe(false)
    expect(live.detail).toMatch(/no live Host/)
  })

  it('skips the Host check without --live', async () => {
    const { paths, io } = goodEnv()
    const results = await runDoctor({ paths, io })
    expect(results.find(r => r.name === 'live Host')).toBeUndefined()
    expect(summarizeDoctor(results).ok).toBe(true)
  })
})

describe('checkLiveHost', () => {
  it('returns the describe value from a healthy Host', async () => {
    const io = makeFakeIo({
      fetch: async (url, init) => {
        expect(url).toBe(`${DEFAULT_HOST_URL}/api/host.describe`)
        expect(init.method).toBe('POST')
        const body = JSON.parse(init.body)
        expect(body.method).toBe('host.describe')
        return { ok: true, json: async () => ({ result: { ok: true, value: { protocolVersion: 1, hostInstanceId: 'i', version: '0.1.0-rc.8' } } }) }
      },
    })
    const value = await checkLiveHost({ url: DEFAULT_HOST_URL, io })
    expect(value.protocolVersion).toBe(1)
  })

  it('sends the deployment bearer credential without putting it in the URL', async () => {
    const token = 's'.repeat(32)
    const io = makeFakeIo({
      fetch: async (url, init) => {
        expect(url).toBe(`${DEFAULT_HOST_URL}/api/host.describe`)
        expect(url).not.toContain(token)
        expect(init.headers.authorization).toBe(`Bearer ${token}`)
        return { ok: true, json: async () => ({ result: { ok: true, value: { protocolVersion: 1 } } }) }
      },
    })
    await checkLiveHost({ url: DEFAULT_HOST_URL, io, token })
  })

  it('throws on non-2xx transport failure', async () => {
    const io = makeFakeIo({ fetch: async () => ({ ok: false, status: 500 }) })
    await expect(checkLiveHost({ url: DEFAULT_HOST_URL, io })).rejects.toThrow(/HTTP 500/)
  })

  it('throws with the business error when the Host rejects the RPC', async () => {
    const io = makeFakeIo({ fetch: async () => ({ ok: true, json: async () => ({ result: { ok: false, error: { code: 'E_NO_HOST', message: 'nope' } } }) }) })
    await expect(checkLiveHost({ url: DEFAULT_HOST_URL, io })).rejects.toThrow(/E_NO_HOST: nope/)
  })
})

describe('checkSessionModels', () => {
  it('reads provider routing without issuing a model request', async () => {
    const io = makeFakeIo({
      fetch: async (url, init) => {
        expect(url).toBe(`${DEFAULT_HOST_URL}/api/session.models`)
        const body = JSON.parse(init.body)
        expect(body).toMatchObject({ method: 'session.models', payload: { sessionId: 'session-1' } })
        return {
          ok: true,
          json: async () => ({ result: { ok: true, value: {
            current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            routable: true,
            failures: [],
          } } }),
        }
      },
    })
    await expect(checkSessionModels({ url: DEFAULT_HOST_URL, sessionId: 'session-1', io }))
      .resolves.toMatchObject({ routable: true })
  })
})

// ---------------------------------------------------------------------------
// failure reporting
// ---------------------------------------------------------------------------

describe('hostLaunchArgv', () => {
  it('defaults to 127.0.0.1:8080 --no-open', () => {
    const argv = hostLaunchArgv({ dshBin: '/d/apps/cli/lib/bin.js' })
    expect(argv).toEqual([process.execPath, '/d/apps/cli/lib/bin.js', 'web', '--host', '127.0.0.1', '--port', '8080', '--no-open'])
  })

  it('derives the host and port from an explicit URL', () => {
    const argv = hostLaunchArgv({ dshBin: '/d/apps/cli/lib/bin.js', hostUrl: 'http://127.0.0.1:18080' })
    expect(argv).toContain('--port')
    expect(argv[argv.indexOf('--port') + 1]).toBe('18080')
  })

  it('refuses a non-loopback bind or a URL with an application path', () => {
    expect(() => hostLaunchArgv({ dshBin: '/d/bin.js', hostUrl: 'http://0.0.0.0:8080' })).toThrow(/loopback/)
    expect(() => hostLaunchArgv({ dshBin: '/d/bin.js', hostUrl: 'http://127.0.0.1:8080/api' })).toThrow(/origin/)
  })
})

describe('hostIsAlive', () => {
  it('treats an exec failure (ps unavailable) as not-alive instead of crashing', async () => {
    const io = makeFakeIo({
      exec: async () => { throw new Error('EPERM') },
    })
    expect(await hostIsAlive(123, io)).toBe(false)
  })

  it('treats a null-status exec error as unknown, not dead', async () => {
    const io = makeFakeIo({
      exec: { 'ps -p 123 -o command=': { status: null, stdout: '', stderr: '', error: 'EPERM' } },
    })
    expect(await probePid(123, io)).toBe('unknown')
  })

  it('confirms a live pid', async () => {
    const io = makeFakeIo({
      exec: { 'ps -p 123 -o command=': { status: 0, stdout: 'node /d/apps/cli/lib/bin.js web\n', stderr: '' } },
    })
    expect(await hostIsAlive(123, io)).toBe(true)
  })

  it('fails Host startup closed when both PID inspection and Host probing are unavailable', () => {
    expect(hostStartPidDecision('unknown', false)).toBe('refuse-unverifiable')
  })

  it('only permits Host startup to clear a PID record proven dead', () => {
    expect(hostStartPidDecision('dead', false)).toBe('clear-stale')
    expect(hostStartPidDecision('alive', false)).toBe('refuse-alive-unreachable')
    expect(hostStartPidDecision('unknown', true)).toBe('already-running')
  })
})

describe('Host startup lease', () => {
  it('serializes contenders and verifies ownership before release', async () => {
    const paths = pathsFor()
    const io = makeFakeIo()
    const releaseFirst = await acquireHostStartLease(paths, io, { waitMs: 100, retryMs: 1 })
    let secondAcquired = false
    const second = acquireHostStartLease(paths, io, { waitMs: 100, retryMs: 1 }).then((release) => {
      secondAcquired = true
      return release
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(secondAcquired).toBe(false)
    await releaseFirst()
    const releaseSecond = await second
    expect(secondAcquired).toBe(true)
    await releaseSecond()
    expect(io.files.has(paths.hostStartLockFile)).toBe(false)
  })

  it('times out without deleting another process lease', async () => {
    const paths = pathsFor()
    const io = makeFakeIo()
    const release = await acquireHostStartLease(paths, io, { waitMs: 100, retryMs: 1 })
    await expect(acquireHostStartLease(paths, io, { waitMs: 0, retryMs: 1 }))
      .rejects.toThrow(/remove the orphaned lease manually/)
    expect(io.files.has(paths.hostStartLockFile)).toBe(true)
    await release()
  })
})

describe('failure reporting', () => {
  it('reports the phase, argv, and exit code — never the environment', () => {
    const report = formatPhaseFailure({
      phase: 'dsh-build',
      argv: ['pnpm', 'build'],
      cwd: '/state/dsh',
      exitCode: 1,
      output: 'error: something broke',
    })
    expect(report).toContain('phase "dsh-build" failed')
    expect(report).toContain('command: pnpm build   (cwd: /state/dsh)')
    expect(report).toContain('exit code: 1')
    expect(report).not.toContain('DSH_HOME')
  })

  it('redacts credential-shaped output', () => {
    const redacted = redactOutput('DSH_HOME=/home/me run failed; TOKEN=super-secret leaked; API_KEY = abc')
    expect(redacted).toContain('DSH_HOME=<redacted>')
    expect(redacted).toContain('TOKEN=<redacted>')
    expect(redacted).not.toContain('super-secret')
    expect(redacted).not.toContain('abc')
  })

  it('bounds and redacts the output tail', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const tail = formatOutputTail(lines.join('\n') + '\nPASSWORD=hunter2 end', 5)
    expect(tail).toContain('26 earlier line(s) omitted')
    expect(tail).toContain('PASSWORD=<redacted>')
    expect(tail).not.toContain('hunter2')
  })
})
