import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeSanitizedProfile } from '../build-release-bundle.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('release profile template', () => {
  it('is generated from tracked inputs without machine-local paths or state', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'dsh-gate-release-profile-'))
    temporaryDirectories.push(destination)

    await writeSanitizedProfile(destination)

    const profile = join(destination, 'profiles', 'web')
    const files = await readdir(profile)
    expect(files.sort()).toEqual(['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml'])
    expect(await readFile(join(profile, 'cordis.yml'), 'utf8')).toMatch(/\[\]\n$/)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toMatch(/\[\]\n$/)
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({})
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@dsh-gate/supervisor-tools',
    ])
    expect(JSON.stringify(manifest)).not.toContain(process.cwd())
    expect(await readFile(join(destination, 'skills', 'dsh-supervised-worker', 'SKILL.md'), 'utf8')).toContain('dsh-supervised-worker')
  })
})
