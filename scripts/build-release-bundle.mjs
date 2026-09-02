#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DSH_FORK_URL, DSH_PINNED_COMMIT } from './dsh-gate-lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = { kind: 'online' }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!['--kind', '--out', '--version'].includes(key)) throw new Error(`unknown argument ${key}`)
    const value = argv[++index]
    if (value === undefined) throw new Error(`${key} requires a value`)
    options[key.slice(2)] = value
  }
  if (!['online', 'offline'].includes(options.kind)) throw new Error('--kind must be online or offline')
  return options
}

function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

async function copyTrackedRuntime(destination) {
  const files = capture('git', ['ls-files', '-z']).split('\0').filter(Boolean)
  for (const file of files) {
    const target = join(destination, file)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(root, file), target, { recursive: true, dereference: false, verbatimSymlinks: true })
  }
  const packages = await readdir(join(root, 'packages'), { withFileTypes: true })
  for (const entry of packages) {
    if (!entry.isDirectory()) continue
    const dist = join(root, 'packages', entry.name, 'dist')
    if (await exists(dist)) await cp(dist, join(destination, 'packages', entry.name, 'dist'), { recursive: true })
  }
}

async function copyWorkspaceDependencies(destination) {
  await cp(join(root, 'node_modules'), join(destination, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true })
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const source = join(root, 'packages', entry.name, 'node_modules')
    if (await exists(source)) {
      await cp(source, join(destination, 'packages', entry.name, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true })
    }
  }
}

async function copyDshBuildOutputs(source, destination) {
  const visit = async relativeDirectory => {
    const directory = join(source, relativeDirectory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || ['.git', '.sessions', '.dsh-build', 'node_modules'].includes(entry.name)) continue
      const relativePath = join(relativeDirectory, entry.name)
      if (entry.name === 'lib') {
        await cp(join(source, relativePath), join(destination, relativePath), { recursive: true, dereference: false, verbatimSymlinks: true })
      } else {
        await visit(relativePath)
      }
    }
  }
  for (const buildRoot of ['apps', 'packages', 'native', 'vendor']) await visit(buildRoot)
  await cp(join(source, 'apps', 'web', 'dist'), join(destination, 'apps', 'web', 'dist'), { recursive: true, dereference: false, verbatimSymlinks: true })
}

async function copyDshDependencies(source, destination) {
  const visit = async relativeDirectory => {
    const directory = join(source, relativeDirectory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || ['.git', '.sessions', '.dsh-build'].includes(entry.name)) continue
      const relativePath = join(relativeDirectory, entry.name)
      if (entry.name === 'node_modules') {
        await cp(join(source, relativePath), join(destination, relativePath), { recursive: true, dereference: false, verbatimSymlinks: true })
      } else {
        await visit(relativePath)
      }
    }
  }
  await cp(join(source, 'node_modules'), join(destination, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true })
  for (const dependencyRoot of ['apps', 'packages', 'native', 'examples', 'python', 'vendor', 'website']) await visit(dependencyRoot)
}

async function copyDshPayload(source, destination, kind) {
  capture('git', ['clone', '--no-hardlinks', '--no-checkout', source, destination])
  capture('git', ['checkout', '--detach', DSH_PINNED_COMMIT], destination)
  capture('git', ['remote', 'set-url', 'origin', DSH_FORK_URL], destination)
  await rm(join(destination, '.git', 'logs'), { recursive: true, force: true })
  await copyDshBuildOutputs(source, destination)
  if (kind === 'offline') await copyDshDependencies(source, destination)
  if (capture('git', ['status', '--porcelain'], destination) !== '') throw new Error('sanitized DSH payload is not clean')
}

export async function writeSanitizedProfile(destination) {
  const profile = join(destination, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'cordis.yml'), [
    '# dsh profile root — an empty entry list. The tree is composed as patches:',
    "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any",
    '# --patch overlays. Edit cordis.patch.yml, not this file.',
    '[]',
    '',
  ].join('\n'))
  await writeFile(join(profile, 'cordis.patch.yml'), [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; `!!js` expressions allowed).',
    '[]',
    '',
  ].join('\n'))
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          '@dsh-gate/supervisor-tools',
        ],
      },
    },
  }, null, 2)}\n`)
  await writeFile(join(profile, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    '',
  ].join('\n'))

  const workerTarget = join(destination, 'skills', 'dsh-supervised-worker', 'SKILL.md')
  await mkdir(dirname(workerTarget), { recursive: true })
  await cp(join(root, 'skills', 'dsh-supervised-worker', 'SKILL.md'), workerTarget)
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const distributionPackage = JSON.parse(await readFile(join(root, 'packages', 'distribution', 'package.json'), 'utf8'))
  const version = options.version ?? distributionPackage.version
  if (version !== distributionPackage.version) throw new Error(`release version ${version} must match npm package version ${distributionPackage.version}`)
  const dshRepo = join(root, '.dsh-state', 'dsh')
  const gateCommit = capture('git', ['rev-parse', 'HEAD'])
  if (capture('git', ['status', '--porcelain']) !== '') throw new Error('dsh-gate checkout must be clean before creating immutable release bytes')
  const dshCommit = capture('git', ['rev-parse', 'HEAD'], dshRepo)
  if (dshCommit !== DSH_PINNED_COMMIT) throw new Error(`DSH checkout ${dshCommit} does not match pin ${DSH_PINNED_COMMIT}`)
  if (capture('git', ['status', '--porcelain'], dshRepo) !== '') throw new Error('DSH checkout must be clean')
  for (const required of [
    join(root, 'packages', 'mcp-server', 'dist', 'cli.js'),
    join(dshRepo, 'apps', 'cli', 'lib', 'bin.js'),
    join(dshRepo, 'apps', 'web', 'dist', 'index.html'),
  ]) if (!(await exists(required))) throw new Error(`missing build output ${required}`)

  const temporary = await mkdtemp(join(tmpdir(), 'dsh-gate-bundle-'))
  try {
    const payload = join(temporary, 'dsh-gate-bundle')
    const runtime = join(payload, 'runtime')
    const bundledDsh = join(payload, 'dsh')
    await mkdir(runtime, { recursive: true })
    await copyTrackedRuntime(runtime)
    if (options.kind === 'offline') {
      await copyWorkspaceDependencies(runtime)
      await rm(join(runtime, 'packages', 'mcp-server', 'node_modules', '@deepseek-ai', 'dsh-client-connection'), { recursive: true, force: true })
    }
    await copyDshPayload(dshRepo, bundledDsh, options.kind)
    const profileTarget = join(payload, 'profile')
    await writeSanitizedProfile(profileTarget)
    const manifest = {
      schemaVersion: 1,
      product: 'dsh-gate',
      version,
      gateCommit,
      dshCommit,
      kind: options.kind,
      platform: platform(),
      arch: arch(),
      createdAt: new Date().toISOString(),
    }
    await writeFile(join(payload, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(runtime, '.dsh-distribution.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const kindSuffix = options.kind === 'offline' ? '-offline' : ''
    const output = resolve(options.out ?? join(root, 'dist', `dsh-gate-runtime-${version}-${platform()}-${arch()}${kindSuffix}.tar.gz`))
    await mkdir(dirname(output), { recursive: true })
    const packed = spawnSync('tar', ['-czf', output, '-C', temporary, 'dsh-gate-bundle'], { stdio: 'inherit' })
    if (packed.status !== 0) throw new Error(`tar failed with ${String(packed.status)}`)
    const digest = await sha256(output)
    await writeFile(`${output}.sha256`, `${digest}  ${output.split(sep).at(-1)}\n`)
    process.stdout.write(`${JSON.stringify({ output, sha256: digest, manifest }, null, 2)}\n`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`[dsh-gate] release bundle failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
