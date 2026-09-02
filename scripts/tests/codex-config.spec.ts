import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const examplePath = fileURLToPath(new URL('../../config/codex-mcp.example.toml', import.meta.url))

describe('Codex MCP example', () => {
  it('leaves enough client timeout headroom around the five-minute wait cadence', async () => {
    const contents = await readFile(examplePath, 'utf8')
    const timeout = contents.match(/^tool_timeout_sec\s*=\s*(\d+)$/m)?.[1]
    expect(Number(timeout)).toBeGreaterThanOrEqual(360)
  })

  it('uses the built MCP executable and the managed Host launcher', async () => {
    const contents = await readFile(examplePath, 'utf8')
    expect(contents).toContain('packages/mcp-server/dist/cli.js')
    expect(contents).toContain('scripts/dsh-gate.mjs","host","start')
  })
})
