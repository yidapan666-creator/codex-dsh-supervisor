import { mkdtemp, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  backupDirectoryFor, migrateLegacyBackups, parseArgs,
} from '../install-codex-skill.mjs'

describe('Codex skill installer', () => {
  it('accepts the pnpm argument separator documented for the package script', () => {
    expect(parseArgs(['--', '--target', '/tmp/personal-skills', '--force'])).toEqual({
      help: false,
      target: '/tmp/personal-skills',
      force: true,
    })
  })

  it('stores backups outside the discoverable skills directory', () => {
    expect(backupDirectoryFor('/Users/example/.agents/skills'))
      .toBe('/Users/example/.agents/skill-backups/codex-dsh-supervisor')
  })

  it('migrates legacy sibling backups without deleting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gate-skill-install-'))
    const target = join(root, 'skills')
    const first = 'codex-dsh-supervisor.backup-2026-01-01'
    const second = 'codex-dsh-supervisor.backup-2026-01-02'
    await mkdir(join(target, first), { recursive: true })
    await mkdir(join(target, second), { recursive: true })

    const moved = await migrateLegacyBackups(target)

    expect(moved).toEqual([
      join(dirname(target), 'skill-backups', 'codex-dsh-supervisor', first),
      join(dirname(target), 'skill-backups', 'codex-dsh-supervisor', second),
    ])
    expect(await readdir(target)).toEqual([])
    expect(await readdir(backupDirectoryFor(target))).toEqual([first, second])
  })
})
