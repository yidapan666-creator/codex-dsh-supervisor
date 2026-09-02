import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MANAGED_BEGIN,
  MANAGED_END,
  normalizeHostUrl,
  parseArgs,
  removeManagedBlock,
  renderCodexBlock,
  replaceManagedBlock,
  runCli,
  sha256File,
  validateBundleManifest,
} from '../lib/installer.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('distribution CLI contract', () => {
  it('parses setup, upgrade, and uninstall without ambiguous sources', () => {
    expect(parseArgs(['setup', '--bundle', '/tmp/b.tgz', '--sha256', 'a'.repeat(64), '--no-start'])).toMatchObject({
      command: 'setup', options: { bundle: '/tmp/b.tgz', start: false, force: false },
    })
    expect(parseArgs(['upgrade']).options.force).toBe(true)
    expect(parseArgs(['uninstall', '--purge']).options.purge).toBe(true)
    expect(parseArgs(['--version'])).toEqual({ command: 'version' })
    expect(() => parseArgs(['setup', '--bundle', 'x', '--version', '1.0.0'])).toThrow(/mutually exclusive/)
  })

  it('accepts only loopback Host origins', () => {
    expect(normalizeHostUrl('http://localhost:18080')).toBe('http://localhost:18080')
    expect(() => normalizeHostUrl('https://example.com')).toThrow(/loopback/)
    expect(() => normalizeHostUrl('http://127.0.0.1:8080/path')).toThrow(/origin/)
  })

  it('validates bundle identity and current platform', () => {
    const manifest = { schemaVersion: 1, product: 'dsh-gate', version: '0.1.0', gateCommit: 'a'.repeat(40), dshCommit: 'b'.repeat(40), kind: 'offline', platform: platform(), arch: arch() }
    expect(validateBundleManifest(manifest)).toBe(manifest)
    expect(() => validateBundleManifest({ ...manifest, arch: 'wrong' })).toThrow(/architecture/)
    expect(() => validateBundleManifest({ ...manifest, version: '../escape' })).toThrow(/path-safe/)
    expect(() => validateBundleManifest({ ...manifest, gateCommit: 'short' })).toThrow(/object IDs/)
  })

  it('owns exactly one replaceable Codex config block', () => {
    const block = renderCodexBlock({ runtimeDir: '/runtime', stateDir: '/state', hostUrl: 'http://127.0.0.1:8080' })
    const first = replaceManagedBlock('model = "x"\n', block)
    expect(first).toContain(MANAGED_BEGIN)
    expect(first).toContain(MANAGED_END)
    expect(replaceManagedBlock(first, block).match(new RegExp(MANAGED_BEGIN, 'g'))).toHaveLength(1)
    expect(removeManagedBlock(first)).toBe('model = "x"\n')
    expect(() => replaceManagedBlock('[mcp_servers.dsh_gate]\ncommand="old"\n', block)).toThrow(/unmanaged/)
  })

  it('hashes the exact bundle bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-gate-hash-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'bundle')
    await writeFile(path, 'payload')
    expect(await sha256File(path)).toBe(createHash('sha256').update('payload').digest('hex'))
  })

  it('refuses to purge a directory without an ownership marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-gate-unowned-'))
    temporaryDirectories.push(directory)
    await expect(runCli(['uninstall', '--purge', '--install-dir', directory, '--codex-home', join(directory, 'codex'), '--skills-dir', join(directory, 'skills')])).rejects.toThrow(/ownership marker/)
  })
})

describe('clean-machine bundle E2E', () => {
  it('sets up, configures, and uninstalls a checksummed fixture bundle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-gate-clean-e2e-'))
    temporaryDirectories.push(directory)
    const payload = join(directory, 'stage', 'dsh-gate-bundle')
    const runtime = join(payload, 'runtime')
    const dsh = join(payload, 'dsh')
    await mkdir(join(runtime, 'scripts'), { recursive: true })
    await mkdir(join(runtime, 'packages', 'mcp-server', 'dist'), { recursive: true })
    await mkdir(join(runtime, 'packages', 'mcp-server', 'node_modules'), { recursive: true })
    await mkdir(join(runtime, 'packages', 'dsh-supervisor-tools', 'node_modules'), { recursive: true })
    await mkdir(join(runtime, 'node_modules'), { recursive: true })
    await mkdir(join(runtime, 'config', 'decision-policies'), { recursive: true })
    await mkdir(join(dsh, 'apps', 'cli', 'lib'), { recursive: true })
    await mkdir(join(dsh, 'node_modules'), { recursive: true })
    await mkdir(join(dsh, 'packages', 'client', 'connection'), { recursive: true })
    await mkdir(join(payload, 'profile', 'profiles', 'web'), { recursive: true })
    await mkdir(join(payload, 'profile', 'skills', 'dsh-supervised-worker'), { recursive: true })
    await writeFile(join(runtime, 'scripts', 'dsh-gate.mjs'), '#!/usr/bin/env node\nif (process.env.DSH_GATE_TEST_FAIL_BOOTSTRAP === "1" && process.argv.includes("bootstrap")) process.exit(23)\n')
    await writeFile(join(runtime, 'packages', 'mcp-server', 'dist', 'cli.js'), 'export {}\n')
    await writeFile(join(runtime, 'packages', 'mcp-server', 'dist', 'index.js'), 'module.exports = {}\n')
    await writeFile(join(runtime, 'config', 'decision-policies', '2026-08-26.v1.json'), '{}\n')
    await writeFile(join(dsh, 'apps', 'cli', 'lib', 'bin.js'), 'process.stdout.write("fixture")\n')
    expect(spawnSync('git', ['init'], { cwd: dsh }).status).toBe(0)
    expect(spawnSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: dsh }).status).toBe(0)
    expect(spawnSync('git', ['config', 'user.name', 'Fixture'], { cwd: dsh }).status).toBe(0)
    expect(spawnSync('git', ['add', '.'], { cwd: dsh }).status).toBe(0)
    expect(spawnSync('git', ['commit', '-m', 'fixture'], { cwd: dsh }).status).toBe(0)
    const dshCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dsh, encoding: 'utf8' }).stdout.trim()
    await writeFile(join(payload, 'profile', 'profiles', 'web', 'package.json'), '{"dependencies":{},"dsh":{"profile":{"bundles":["@dsh-gate/supervisor-tools"]}}}\n')
    await writeFile(join(payload, 'profile', 'skills', 'dsh-supervised-worker', 'SKILL.md'), '# worker\n')
    await writeFile(join(payload, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 1, product: 'dsh-gate', version: '9.9.9', gateCommit: 'a'.repeat(40), dshCommit, kind: 'offline', platform: platform(), arch: arch(),
    })}\n`)
    const bundle = join(directory, 'fixture.tar.gz')
    const packed = spawnSync('tar', ['-czf', bundle, '-C', join(directory, 'stage'), 'dsh-gate-bundle'])
    expect(packed.status).toBe(0)
    const digest = await sha256File(bundle)
    const installDir = join(directory, 'install')
    const codexHome = join(directory, 'codex')

    await runCli(['setup', '--bundle', bundle, '--sha256', digest, '--install-dir', installDir, '--codex-home', codexHome, '--skills-dir', join(directory, 'skills'), '--no-start', '--no-skill'])
    const config = await readFile(join(codexHome, 'config.toml'), 'utf8')
    expect(config).toContain(MANAGED_BEGIN)
    expect(JSON.parse(await readFile(join(installDir, 'current.json'), 'utf8')).version).toBe('9.9.9')
    expect(await readFile(join(installDir, 'state', 'install.json'), 'utf8')).toContain(`release:${'a'.repeat(40)}`)
    expect((await readFile(join(installDir, 'state', 'host', 'auth.token'), 'utf8')).trim()).toHaveLength(43)

    const previousCurrent = await readFile(join(installDir, 'current.json'), 'utf8')
    const previousConfig = await readFile(join(codexHome, 'config.toml'), 'utf8')
    await runCli(['setup', '--bundle', bundle, '--sha256', digest, '--install-dir', installDir, '--codex-home', codexHome, '--skills-dir', join(directory, 'skills'), '--no-start', '--no-skill'])
    expect(await readFile(join(installDir, 'current.json'), 'utf8')).toBe(previousCurrent)

    await writeFile(join(payload, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 1, product: 'dsh-gate', version: '9.9.10', gateCommit: 'c'.repeat(40), dshCommit, kind: 'online', platform: platform(), arch: arch(),
    })}\n`)
    const brokenBundle = join(directory, 'broken-upgrade.tar.gz')
    expect(spawnSync('tar', ['-czf', brokenBundle, '-C', join(directory, 'stage'), 'dsh-gate-bundle']).status).toBe(0)
    process.env.DSH_GATE_TEST_FAIL_BOOTSTRAP = '1'
    try {
      await expect(runCli(['upgrade', '--bundle', brokenBundle, '--sha256', await sha256File(brokenBundle), '--install-dir', installDir, '--codex-home', codexHome, '--skills-dir', join(directory, 'skills'), '--no-start', '--no-skill'])).rejects.toThrow(/failed/)
    } finally {
      delete process.env.DSH_GATE_TEST_FAIL_BOOTSTRAP
    }
    expect(await readFile(join(installDir, 'current.json'), 'utf8')).toBe(previousCurrent)
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toBe(previousConfig)
    expect(await readFile(join(installDir, 'state', 'dsh-home', 'profiles', 'web', 'package.json'), 'utf8')).toContain(`9.9.9-${'a'.repeat(12)}`)
    await expect(readFile(join(installDir, 'versions', `9.9.10-${'c'.repeat(12)}`, '.dsh-distribution.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await runCli(['uninstall', '--install-dir', installDir, '--codex-home', codexHome, '--skills-dir', join(directory, 'skills')])
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).not.toContain(MANAGED_BEGIN)
    expect(await readFile(join(installDir, 'state', 'install.json'), 'utf8')).toContain(`release:${'a'.repeat(40)}`)
    expect(JSON.parse(await readFile(join(installDir, 'retained.json'), 'utf8')).product).toBe('dsh-gate')
    await runCli(['uninstall', '--purge', '--install-dir', installDir, '--codex-home', codexHome, '--skills-dir', join(directory, 'skills')])
    await expect(readFile(join(installDir, 'state', 'install.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
