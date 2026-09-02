import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const race = vi.hoisted(() => ({ afterOpen: undefined as (() => Promise<void>) | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args)
      await race.afterOpen?.()
      return handle
    },
  }
})

import { admitArtifact } from '../src/artifacts.js'

describe('artifact admission path races', () => {
  it('rejects an intermediate-directory replacement after the file is opened', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gate-artifact-race-'))
    const original = join(root, 'out')
    await mkdir(original)
    await writeFile(join(original, 'report.txt'), 'admitted inode')
    race.afterOpen = async () => {
      race.afterOpen = undefined
      await rename(original, join(root, 'out-before-swap'))
      await mkdir(original)
      await writeFile(join(original, 'report.txt'), 'replacement inode')
    }

    await expect(admitArtifact(root, 'out/report.txt'))
      .rejects.toThrow('artifact path changed during admission')
  })
})
