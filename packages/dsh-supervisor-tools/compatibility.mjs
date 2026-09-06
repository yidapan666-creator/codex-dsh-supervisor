import { DSH_GATE_BUILD_ID } from './build-identity.mjs'

/** One lockstep compatibility contract shared by MCP, Host plugin, and doctor. */
export const EXPECTED_DSH_HOST_PROTOCOL_VERSION = 1
export const EXPECTED_DSH_HOST_VERSION = '0.1.1-rc.2'
export const EXPECTED_GATE_PROTOCOL_VERSION = 1
export const EXPECTED_GATE_PLUGIN_NAME = '@dsh-gate/supervisor-tools'
export const EXPECTED_GATE_PLUGIN_VERSION = '0.1.0'
export const EXPECTED_WORKER_PROTOCOL_VERSION = 2
export const EXPECTED_GATE_BUILD_ID = DSH_GATE_BUILD_ID
export const EXPECTED_GATE_CAPABILITIES = Object.freeze([
  'idempotent-admission-v1',
  'durable-before-execute-v1',
  'recovery-capsule-v1',
  'run-tree-token-budget-v1',
  'crash-durable-token-reservations-v1',
  'host-git-baseline-v1',
  'direct-child-authority-v1',
  'strict-handoff-v1',
  'bearer-auth-v1',
])

export function dshHostCompatibilityError(value) {
  if (typeof value !== 'object' || value === null) return 'malformed DSH Host descriptor'
  const failures = []
  if (value.protocolVersion !== EXPECTED_DSH_HOST_PROTOCOL_VERSION) {
    failures.push(`protocol version ${String(value.protocolVersion)} (expected ${EXPECTED_DSH_HOST_PROTOCOL_VERSION})`)
  }
  if (value.version !== EXPECTED_DSH_HOST_VERSION) {
    failures.push(`Host version ${String(value.version)} (expected ${EXPECTED_DSH_HOST_VERSION})`)
  }
  if (typeof value.hostInstanceId !== 'string' || value.hostInstanceId.trim() === '') {
    failures.push('hostInstanceId missing')
  }
  return failures.length === 0 ? undefined : `incompatible DSH Host: ${failures.join('; ')}`
}

export function gateDescriptorCompatibilityError(value) {
  if (typeof value !== 'object' || value === null) return 'malformed dsh-gate supervisor descriptor'
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter(entry => typeof entry === 'string')
    : []
  const missing = EXPECTED_GATE_CAPABILITIES.filter(capability => !capabilities.includes(capability))
  const incompatible = value.schemaVersion !== 1
    || value.gateProtocolVersion !== EXPECTED_GATE_PROTOCOL_VERSION
    || value.pluginName !== EXPECTED_GATE_PLUGIN_NAME
    || value.pluginVersion !== EXPECTED_GATE_PLUGIN_VERSION
    || value.buildId !== EXPECTED_GATE_BUILD_ID
    || value.workerProtocolVersion !== EXPECTED_WORKER_PROTOCOL_VERSION
    || missing.length > 0
  return incompatible
    ? `incompatible dsh-gate supervisor plugin${missing.length === 0 ? '' : `; missing capabilities: ${missing.join(', ')}`}`
    : undefined
}
