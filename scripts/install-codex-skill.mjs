#!/usr/bin/env node

import { cp, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_NAME = 'codex-dsh-supervisor'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'skills', SKILL_NAME)

function usage() {
  return [
    'Install the dsh-gate Codex supervisor skill into an explicit personal skill directory.',
    '',
    'Usage:',
    '  pnpm skill:install -- --target /absolute/path/to/skills [--force]',
    '',
    'The destination is <target>/codex-dsh-supervisor.',
    '--force replaces an existing install but preserves it as a timestamped sibling backup.',
  ].join('\n')
}

function parseArgs(argv) {
  let target
  let force = false
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--help') return { help: true, force }
    if (argument === '--force') {
      force = true
      continue
    }
    if (argument === '--target') {
      target = argv[++index]
      if (target === undefined) throw new Error('--target requires an absolute directory path')
      continue
    }
    throw new Error(`unknown argument ${argument}`)
  }
  if (target === undefined) throw new Error('--target is required; dsh-gate never guesses or writes a global skill directory')
  if (!target.startsWith('/')) throw new Error('--target must be an absolute directory path')
  return { help: false, force, target: resolve(target) }
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  await mkdir(options.target, { recursive: true })
  const destination = join(options.target, SKILL_NAME)
  const installed = await exists(destination)
  if (installed && !options.force) {
    throw new Error(`${destination} already exists; inspect it, then rerun with --force to preserve-and-replace it`)
  }

  const stagingRoot = await mkdtemp(join(options.target, '.dsh-gate-skill-'))
  const staged = join(stagingRoot, SKILL_NAME)
  let backup
  try {
    await cp(source, staged, { recursive: true, errorOnExist: true })
    if (installed) {
      backup = `${destination}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
      await rename(destination, backup)
    }
    try {
      await rename(staged, destination)
    } catch (error) {
      if (backup !== undefined) await rename(backup, destination)
      throw error
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }

  process.stdout.write(`Installed ${SKILL_NAME} at ${destination}\n`)
  if (backup !== undefined) process.stdout.write(`Previous install preserved at ${backup}\n`)
  process.stdout.write('Restart Codex so the updated skill is discovered.\n')
}

main().catch((error) => {
  process.stderr.write(`[dsh-gate] skill install failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
