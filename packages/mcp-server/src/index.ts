#!/usr/bin/env node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createServer } from './server.js'

export { createServer } from './server.js'
export { GatewayManager } from './gateway.js'
export { deriveObservation, parseTaskPacket, timeoutObservation } from './fold.js'
export * from './contracts.js'

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  serveStdio(() => createServer(), {
    onerror: error => process.stderr.write(`[dsh-gate] ${error.stack ?? error.message}\n`),
  })
}
