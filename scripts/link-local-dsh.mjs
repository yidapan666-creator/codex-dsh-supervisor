import { lstat, mkdir, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const sourceRoot = resolve(process.argv[2] ?? process.env.DSH_REPO ?? '')
if (process.argv[2] === undefined && process.env.DSH_REPO === undefined) {
  throw new Error('usage: pnpm link:dsh -- /path/to/deepseek-harness (or set DSH_REPO)')
}

const links = [
  ['packages/mcp-server/node_modules/@deepseek-ai/dsh-client-connection', 'packages/client/connection'],
]

for (const [destination, packagePath] of links) {
  const source = join(sourceRoot, packagePath)
  const stat = await lstat(join(source, 'package.json'))
  if (!stat.isFile()) throw new Error(`not a DSH package: ${source}`)
  const absoluteDestination = resolve(destination)
  await mkdir(dirname(absoluteDestination), { recursive: true })
  await rm(absoluteDestination, { force: true, recursive: true })
  await symlink(source, absoluteDestination, 'dir')
  process.stdout.write(`linked ${absoluteDestination} -> ${source}\n`)
}
