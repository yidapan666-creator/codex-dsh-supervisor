import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(scriptDir, '..')
const pluginRoot = join(workspaceRoot, 'packages', 'dsh-supervisor-tools')
const identityFile = join(pluginRoot, 'build-identity.mjs')
const compiledIdentityFile = join(pluginRoot, 'src', 'build-identity.ts')

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(join(directory, entry.name))
    : [join(directory, entry.name)]))
  return nested.flat()
}

export async function expectedBuildIdentity() {
  const files = [
    ...(await sourceFiles(join(pluginRoot, 'src'))).filter(file => file !== compiledIdentityFile),
    join(pluginRoot, 'cordis.patch.yml'),
  ].sort((left, right) => left.localeCompare(right))
  const hash = createHash('sha256')
  for (const file of files) {
    const name = relative(pluginRoot, file).split('\\').join('/')
    hash.update(`${name}\0`)
    hash.update(await readFile(file))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

export async function recordedBuildIdentity() {
  const source = await readFile(identityFile, 'utf8')
  const match = source.match(/DSH_GATE_BUILD_ID\s*=\s*'([^']+)'/)
  if (match?.[1] === undefined) throw new Error('build-identity.mjs has no DSH_GATE_BUILD_ID literal')
  const compiledSource = await readFile(compiledIdentityFile, 'utf8')
  const compiled = compiledSource.match(/DSH_GATE_COMPILED_BUILD_ID\s*=\s*'([^']+)'/)
  if (compiled?.[1] === undefined) throw new Error('src/build-identity.ts has no DSH_GATE_COMPILED_BUILD_ID literal')
  if (compiled[1] !== match[1]) throw new Error(`build identity sources disagree: ${match[1]} != ${compiled[1]}`)
  return match[1]
}

async function main() {
  const expected = await expectedBuildIdentity()
  const recorded = await recordedBuildIdentity()
  if (process.argv.includes('--write')) {
    const source = await readFile(identityFile, 'utf8')
    const compiledSource = await readFile(compiledIdentityFile, 'utf8')
    await writeFile(identityFile, source.replace(recorded, expected), 'utf8')
    await writeFile(compiledIdentityFile, compiledSource.replace(recorded, expected), 'utf8')
    process.stdout.write(`${expected}\n`)
    return
  }
  if (recorded !== expected) {
    throw new Error(`stale dsh-gate build identity: recorded ${recorded}, expected ${expected}; run pnpm build-id:update`)
  }
  process.stdout.write(`${expected}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
