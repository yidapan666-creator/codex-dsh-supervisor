import { createHash } from 'node:crypto'
import { link, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { admitArtifact, admitArtifacts } from '../src/artifacts.js'

async function tempRoot(prefix = 'dsh-gate-artifact-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

describe('artifact admission', () => {
  it('hashes a regular file inside the authoritative session cwd', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'out'))
    await writeFile(join(root, 'out', 'report.txt'), 'hello')
    await expect(admitArtifact(root, 'out/report.txt')).resolves.toEqual({
      path: 'out/report.txt',
      bytes: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    })
  })

  it('rejects traversal and symlink artifacts after realpath resolution', async () => {
    const root = await tempRoot()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-gate-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'))
    await expect(admitArtifact(root, '../outside.txt')).rejects.toThrow()
    await expect(admitArtifact(root, 'linked.txt')).rejects.toThrow('symbolic link')
  })

  it('rejects an artifact whose intermediate directory is a symlink out of the cwd', async () => {
    const root = await tempRoot()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-gate-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'linked-dir'))
    await expect(admitArtifact(root, 'linked-dir/secret.txt'))
      .rejects.toThrow(/resolves outside the session cwd/)
  })

  it('fails closed when the session has no cwd', async () => {
    await expect(admitArtifact(undefined, 'artifact.txt')).rejects.toThrow('session cwd')
  })

  it('rejects a hard-linked artifact even when both names are inside the cwd', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'source.txt'), 'shared inode')
    await link(join(root, 'source.txt'), join(root, 'artifact.txt'))
    await expect(admitArtifact(root, 'artifact.txt')).rejects.toThrow('hard-linked')
  })

  it('hashes a multi-chunk file without loading it whole', async () => {
    const root = await tempRoot()
    const content = Buffer.alloc(200_000)
    for (let index = 0; index < content.length; index++) content[index] = index % 251
    await writeFile(join(root, 'big.bin'), content)
    const expected = createHash('sha256').update(content).digest('hex')
    await expect(admitArtifact(root, 'big.bin')).resolves.toEqual({
      path: 'big.bin',
      bytes: content.length,
      sha256: expected,
    })
  })

  it('rejects an artifact larger than the per-artifact byte limit without hashing it', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'huge.bin'), Buffer.alloc(10_000, 1))
    await expect(admitArtifact(root, 'huge.bin', { maxBytesPerArtifact: 1_024 }))
      .rejects.toThrow(/exceeds 1024 bytes/)
  })

  it('rejects a manifest exceeding the artifact count limit before hashing', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')
    await expect(admitArtifacts(root, ['a.txt', 'b.txt'], { maxArtifacts: 1 }))
      .rejects.toThrow(/exceeds 1 entries/)
  })

  it('rejects a manifest exceeding the total byte limit', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'a'.repeat(100))
    await writeFile(join(root, 'b.txt'), 'b'.repeat(100))
    await expect(admitArtifacts(root, ['a.txt', 'b.txt'], { maxTotalBytes: 150 }))
      .rejects.toThrow(/exceeds 150 total bytes/)
  })

  it('admits a manifest within limits in input order', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'alpha')
    await writeFile(join(root, 'b.txt'), 'beta')
    const manifest = await admitArtifacts(root, ['a.txt', 'b.txt'])
    expect(manifest.map(entry => entry.path)).toEqual(['a.txt', 'b.txt'])
    expect(manifest.reduce((total, entry) => total + entry.bytes, 0)).toBe(9)
  })

  it('admits a long-handoff report under .dsh-handoff/<taskId>/ as a relative artifact', async () => {
    const root = await tempRoot()
    const reportDir = join(root, '.dsh-handoff', 'task-123')
    await mkdir(reportDir, { recursive: true })
    const content = '# detailed handoff report'
    await writeFile(join(reportDir, 'report.md'), content)
    const manifest = await admitArtifacts(root, ['.dsh-handoff/task-123/report.md'])
    expect(manifest).toHaveLength(1)
    expect(manifest[0]).toMatchObject({
      path: '.dsh-handoff/task-123/report.md',
      bytes: content.length,
    })
  })
})
