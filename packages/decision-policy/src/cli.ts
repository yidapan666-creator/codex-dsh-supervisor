#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { compareDecision, decisionPolicyDigest, parseDecisionFacts, parseDecisionPolicy } from './index.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function jsonArgument(inlineName: string, fileName: string): Promise<unknown> {
  const inline = argument(inlineName)
  const file = argument(fileName)
  if (inline !== undefined && file !== undefined) throw new Error(`use only one of ${inlineName} or ${fileName}`)
  if (inline !== undefined) return JSON.parse(inline) as unknown
  if (file !== undefined) return JSON.parse(await readFile(file, 'utf8')) as unknown
  throw new Error(`${inlineName} or ${fileName} is required`)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command !== 'explain' && command !== 'dry-run') {
    throw new Error('usage: dsh-decision-policy explain|dry-run --policy <file> --facts <json>|--facts-file <file> [--shadow <file>]')
  }
  const policyFile = argument('--policy')
  if (policyFile === undefined) throw new Error('--policy is required')
  const active = parseDecisionPolicy(JSON.parse(await readFile(policyFile, 'utf8')) as unknown)
  const shadowFile = argument('--shadow')
  const shadow = shadowFile === undefined
    ? undefined
    : parseDecisionPolicy(JSON.parse(await readFile(shadowFile, 'utf8')) as unknown)
  const facts = parseDecisionFacts(await jsonArgument('--facts', '--facts-file'))
  const comparison = compareDecision(facts, active, shadow)
  process.stdout.write(`${JSON.stringify({
    facts,
    activePolicy: { version: active.version, digest: decisionPolicyDigest(active) },
    ...shadow === undefined ? {} : { shadowPolicy: { version: shadow.version, digest: decisionPolicyDigest(shadow) } },
    ...comparison,
  }, undefined, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
