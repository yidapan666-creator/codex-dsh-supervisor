import { link, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { admitArtifact } from '../src/artifacts.js'

describe('artifact admission', () => {
  it('hashes a regular file inside the authoritative session cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gate-artifact-'))
    await mkdir(join(root, 'out'))
    await writeFile(join(root, 'out', 'report.txt'), 'hello')
    await expect(admitArtifact(root, 'out/report.txt')).resolves.toEqual({
      path: 'out/report.txt',
      bytes: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    })
  })

  it('rejects traversal and symlink artifacts after realpath resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gate-artifact-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-gate-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'))
    await expect(admitArtifact(root, '../outside.txt')).rejects.toThrow()
    await expect(admitArtifact(root, 'linked.txt')).rejects.toThrow('symbolic link')
  })

  it('fails closed when the session has no cwd', async () => {
    await expect(admitArtifact(undefined, 'artifact.txt')).rejects.toThrow('session cwd')
  })

  it('rejects a hard-linked artifact even when both names are inside the cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gate-artifact-'))
    await writeFile(join(root, 'source.txt'), 'shared inode')
    await link(join(root, 'source.txt'), join(root, 'artifact.txt'))
    await expect(admitArtifact(root, 'artifact.txt')).rejects.toThrow('hard-linked')
  })
})
