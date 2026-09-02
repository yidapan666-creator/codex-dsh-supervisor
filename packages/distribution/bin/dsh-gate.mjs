#!/usr/bin/env node

import { runCli } from '../lib/installer.mjs'

runCli(process.argv.slice(2)).catch(error => {
  process.stderr.write(`[dsh-gate] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
