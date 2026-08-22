import { createHash } from 'node:crypto'
import { constants as fsConstants, lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

// Safety checks are a TypeScript adaptation of multiAgents' MIT-licensed
// artifact_manifest.py at commit 3df6b355b73b4727b7cf2dc14338928e256c839f.
// See docs/source-provenance.md; DSH remains the authoritative session store.

export interface ArtifactManifestEntry {
  path: string
  bytes: number
  sha256: string
}

export interface ArtifactAdmissionLimits {
  /** Maximum number of manifest entries admitted in one call. */
  maxArtifacts?: number
  /** Maximum bytes per artifact; a larger regular file fails closed. */
  maxBytesPerArtifact?: number
  /** Maximum total bytes across the whole manifest, enforced sequentially. */
  maxTotalBytes?: number
}

export const DEFAULT_MAX_ARTIFACTS = 64
export const DEFAULT_MAX_BYTES_PER_ARTIFACT = 64 * 1024 * 1024
export const DEFAULT_MAX_TOTAL_ARTIFACT_BYTES = 256 * 1024 * 1024

const READ_CHUNK_BYTES = 64 * 1024
// O_NOFOLLOW rejects a final-component symlink swapped in after realpath;
// O_NONBLOCK keeps a FIFO from blocking open() so fstat can reject it.
const READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW === undefined ? 0 : fsConstants.O_NOFOLLOW)
  | (fsConstants.O_NONBLOCK === undefined ? 0 : fsConstants.O_NONBLOCK)

function isContained(root: string, target: string): boolean {
  const suffix = relative(root, target)
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}

/**
 * Validate and hash one worker-reported artifact inside its session cwd.
 *
 * The digest is computed through the opened file handle: the file fstat'ed is the
 * file hashed, so a swap between validation and read cannot redirect the digest
 * outside the cwd. Reads are chunked with a per-artifact byte cap, so admission
 * never loads an unbounded artifact into memory.
 */
export async function admitArtifact(
  workspaceCwd: string | undefined,
  artifactPath: string,
  limits: ArtifactAdmissionLimits = {},
): Promise<ArtifactManifestEntry> {
  const maxBytes = limits.maxBytesPerArtifact ?? DEFAULT_MAX_BYTES_PER_ARTIFACT
  if (workspaceCwd === undefined) throw new Error('artifact admission requires a session cwd')
  if (isAbsolute(artifactPath)) throw new Error(`artifact path must be relative: ${artifactPath}`)
  if (artifactPath.trim() === '') throw new Error('artifact path must not be blank')

  const workspace = await realpath(workspaceCwd)
  const lexicalTarget = resolve(workspace, artifactPath)
  if (!isContained(workspace, lexicalTarget)) {
    throw new Error(`artifact path escapes the session cwd: ${artifactPath}`)
  }
  // Conservative policy: the reported artifact path itself must not be a symlink.
  const lexicalEntry = await lstat(lexicalTarget)
  if (lexicalEntry.isSymbolicLink()) throw new Error(`artifact must not be a symbolic link: ${artifactPath}`)
  const resolvedTarget = await realpath(lexicalTarget)
  if (!isContained(workspace, resolvedTarget)) {
    throw new Error(`artifact resolves outside the session cwd: ${artifactPath}`)
  }

  const handle = await open(resolvedTarget, READ_FLAGS)
  try {
    const entry = await handle.stat()
    if (!entry.isFile()) throw new Error(`artifact must be a regular file: ${artifactPath}`)
    if (entry.nlink !== 1) throw new Error(`artifact must not be hard-linked: ${artifactPath}`)
    if (entry.size > maxBytes) throw new Error(`artifact exceeds ${maxBytes} bytes: ${artifactPath}`)

    const hash = createHash('sha256')
    const buffer = Buffer.alloc(READ_CHUNK_BYTES)
    let bytes = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes)
      if (bytesRead === 0) break
      bytes += bytesRead
      if (bytes > maxBytes) throw new Error(`artifact exceeds ${maxBytes} bytes: ${artifactPath}`)
      hash.update(buffer.subarray(0, bytesRead))
    }
    return {
      path: relative(workspace, resolvedTarget),
      bytes,
      sha256: hash.digest('hex'),
    }
  } finally {
    await handle.close()
  }
}

/**
 * Validate and hash a complete artifact list without accepting partial output.
 * Admission is sequential so at most one artifact is in memory at a time, and the
 * whole manifest is bounded by count and total-byte limits.
 */
export async function admitArtifacts(
  workspaceCwd: string | undefined,
  artifactPaths: readonly string[],
  limits: ArtifactAdmissionLimits = {},
): Promise<ArtifactManifestEntry[]> {
  const maxArtifacts = limits.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_ARTIFACT_BYTES
  if (artifactPaths.length > maxArtifacts) {
    throw new Error(`artifact manifest exceeds ${maxArtifacts} entries`)
  }
  const manifest: ArtifactManifestEntry[] = []
  let totalBytes = 0
  for (const path of artifactPaths) {
    const entry = await admitArtifact(workspaceCwd, path, limits)
    totalBytes += entry.bytes
    if (totalBytes > maxTotalBytes) {
      throw new Error(`artifact manifest exceeds ${maxTotalBytes} total bytes`)
    }
    manifest.push(entry)
  }
  return manifest
}
