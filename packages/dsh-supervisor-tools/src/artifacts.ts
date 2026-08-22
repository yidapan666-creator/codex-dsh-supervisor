import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

// Safety checks are a TypeScript adaptation of multiAgents' MIT-licensed
// artifact_manifest.py at commit 3df6b355b73b4727b7cf2dc14338928e256c839f.
// See docs/source-provenance.md; DSH remains the authoritative session store.

export interface ArtifactManifestEntry {
  path: string
  bytes: number
  sha256: string
}

function isContained(root: string, target: string): boolean {
  const suffix = relative(root, target)
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}

/** Validate and hash one worker-reported artifact inside its session cwd. */
export async function admitArtifact(
  workspaceCwd: string | undefined,
  artifactPath: string,
): Promise<ArtifactManifestEntry> {
  if (workspaceCwd === undefined) throw new Error('artifact admission requires a session cwd')
  if (isAbsolute(artifactPath)) throw new Error(`artifact path must be relative: ${artifactPath}`)
  if (artifactPath.trim() === '') throw new Error('artifact path must not be blank')

  const workspace = await realpath(workspaceCwd)
  const lexicalTarget = resolve(workspace, artifactPath)
  if (!isContained(workspace, lexicalTarget)) {
    throw new Error(`artifact path escapes the session cwd: ${artifactPath}`)
  }
  const entry = await lstat(lexicalTarget)
  if (entry.isSymbolicLink()) throw new Error(`artifact must not be a symbolic link: ${artifactPath}`)
  if (!entry.isFile()) throw new Error(`artifact must be a regular file: ${artifactPath}`)
  if (entry.nlink !== 1) throw new Error(`artifact must not be hard-linked: ${artifactPath}`)

  const target = await realpath(lexicalTarget)
  if (!isContained(workspace, target)) {
    throw new Error(`artifact resolves outside the session cwd: ${artifactPath}`)
  }
  const bytes = await readFile(target)
  return {
    path: relative(workspace, target),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

/** Validate and hash a complete artifact list without accepting partial output. */
export async function admitArtifacts(
  workspaceCwd: string | undefined,
  artifactPaths: readonly string[],
): Promise<ArtifactManifestEntry[]> {
  return Promise.all(artifactPaths.map(path => admitArtifact(workspaceCwd, path)))
}
