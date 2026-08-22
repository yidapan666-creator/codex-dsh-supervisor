#!/usr/bin/env node
// Executable entry for the dsh-gate MCP stdio server. The static import graph
// pulls in @deepseek-ai/dsh-client-connection/network-client, whose generic
// exports are not yet part of any published DSH release. Probing that specifier
// first turns Node's cryptic module-resolution failure into a clear diagnostic.
const NETWORK_CLIENT_SPECIFIER = '@deepseek-ai/dsh-client-connection/network-client'

try {
  await import(NETWORK_CLIENT_SPECIFIER)
} catch (error) {
  const code = error instanceof Error && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined
  const hint = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
    ? '\n\nThe DSH network-client seam this server needs is not published yet. Until the generic '
      + 'upstream release lands, run the local development link described in README.md: '
      + 'pnpm link:dsh -- /path/to/deepseek-harness'
    : ''
  process.stderr.write(
    `[dsh-gate] cannot load ${NETWORK_CLIENT_SPECIFIER}: ${error instanceof Error ? error.message : String(error)}${hint}\n`,
  )
  process.exit(1)
}

const [{ createServer }, { serveStdio }] = await Promise.all([
  import('./server.js'),
  import('@modelcontextprotocol/server/stdio'),
])
serveStdio(() => createServer(), {
  onerror: error => process.stderr.write(`[dsh-gate] ${error.stack ?? error.message}\n`),
})
