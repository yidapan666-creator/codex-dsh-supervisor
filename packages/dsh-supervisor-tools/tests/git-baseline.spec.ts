import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileGitBaselineStore } from '../src/index.js'

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], (error) => error === null ? resolve() : reject(error))
  })
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gate-git-baseline-'))
  await git(root, ['init', '--quiet'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await git(root, ['config', 'user.name', 'dsh-gate test'])
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'src', 'app.ts'), 'export const value = 1\n')
  await writeFile(join(root, 'docs', 'guide.md'), '# guide\n')
  await writeFile(join(root, 'preexisting.txt'), 'user change baseline\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '--quiet', '-m', 'baseline'])
  return root
}

describe('Host Git baseline store', () => {
  it('preserves pre-existing dirt and rejects only task-era changes outside allowed prefixes', async () => {
    const root = await repository()
    const ledger = await mkdtemp(join(tmpdir(), 'dsh-gate-git-ledger-'))
    try {
      await writeFile(join(root, 'preexisting.txt'), 'user-owned dirty state\n')
      const store = new FileGitBaselineStore(ledger)
      const baseline = await store.capture({
        sessionId: 'session-1', runId: 'run-1', cwd: root, allowedScope: ['src'],
      })
      expect(baseline.allowedPrefixes).toEqual(['src'])
      await expect(store.verify({ sessionId: 'session-1', runId: 'run-1', cwd: root }))
        .resolves.toMatchObject({ changedPaths: [], outOfScopePaths: [] })

      await writeFile(join(root, 'src', 'app.ts'), 'export const value = 2\n')
      await expect(store.verify({ sessionId: 'session-1', runId: 'run-1', cwd: root }))
        .resolves.toMatchObject({ changedPaths: ['src/app.ts'], outOfScopePaths: [] })

      await writeFile(join(root, 'docs', 'guide.md'), '# changed outside scope\n')
      const violated = await store.verify({ sessionId: 'session-1', runId: 'run-1', cwd: root })
      expect(violated.changedPaths).toEqual(['docs/guide.md', 'src/app.ts'])
      expect(violated.outOfScopePaths).toEqual(['docs/guide.md'])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(ledger, { recursive: true, force: true })
    }
  })

  it('detects a further edit to a path that was already dirty at admission', async () => {
    const root = await repository()
    const ledger = await mkdtemp(join(tmpdir(), 'dsh-gate-git-ledger-'))
    try {
      await writeFile(join(root, 'preexisting.txt'), 'first dirty value\n')
      const store = new FileGitBaselineStore(ledger)
      await store.capture({ sessionId: 'session-2', runId: 'run-2', cwd: root })
      await writeFile(join(root, 'preexisting.txt'), 'worker changed user dirt\n')
      await expect(store.verify({ sessionId: 'session-2', runId: 'run-2', cwd: root }))
        .resolves.toMatchObject({ changedPaths: ['preexisting.txt'], outOfScopePaths: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(ledger, { recursive: true, force: true })
    }
  })

  it('rejects traversal in writer scope before work starts', async () => {
    const root = await repository()
    const ledger = await mkdtemp(join(tmpdir(), 'dsh-gate-git-ledger-'))
    try {
      const store = new FileGitBaselineStore(ledger)
      await expect(store.capture({
        sessionId: 'session-3', runId: 'run-3', cwd: root, allowedScope: ['../outside'],
      })).rejects.toThrow('escapes the session cwd')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(ledger, { recursive: true, force: true })
    }
  })

  it('does not reuse one session/run baseline under a different allowed scope', async () => {
    const root = await repository()
    const ledger = await mkdtemp(join(tmpdir(), 'dsh-gate-git-ledger-'))
    try {
      const store = new FileGitBaselineStore(ledger)
      await store.capture({ sessionId: 'session-4', runId: 'run-4', cwd: root, allowedScope: ['src'] })

      await expect(store.capture({
        sessionId: 'session-4', runId: 'run-4', cwd: root, allowedScope: ['docs'],
      })).rejects.toThrow('identity changed across admission retry')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(ledger, { recursive: true, force: true })
    }
  })
})
