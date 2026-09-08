import { describe, expect, it } from 'vitest'
import { createServer, toolFailureEnvelope } from '../src/server.js'
import { HostDiscoveryError } from '../src/gateway.js'
import { ProtocolContractError } from '../src/host.js'
import { taskAdmissionReceiptSchema } from '../src/contracts.js'

describe('public dsh_task contract', () => {
  it('advertises the exact workstream shape even when a client type projection loses nested fields', () => {
    const server = createServer({} as never)
    const tools = (server as unknown as {
      _registeredTools: Record<string, { description?: string; outputSchema?: unknown }>
    })._registeredTools
    const task = tools.dsh_task

    expect(task?.description).toContain('id matching /^[A-Z][A-Z0-9_-]{0,15}$/')
    expect(task?.description).toContain('outcome, delegation, and doneWhen')
    expect(task?.description).toContain('integration')
    expect(task?.description).toContain('supervisionMode')
    expect(task?.outputSchema).toBe(taskAdmissionReceiptSchema)
  })

  it('defines a strict, machine-readable admission receipt', () => {
    expect(taskAdmissionReceiptSchema.parse({
      schemaVersion: 1,
      hostInstanceId: 'host-1',
      sessionId: 'session-1',
      taskId: 'session-1',
      requestId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222',
      objective: 'Audit the repository',
      writerMode: 'read_only',
      supervisionMode: 'delegated',
      agentPreset: 'standard',
      instructionProfile: 'engineering-v1',
      executionBrief: {
        source: 'CODEX_COMPILED', workstreamCount: 1, workstreamIds: ['AUDIT'],
      },
      accepted: true,
      reconciled: false,
      admissionBoundarySeq: 10,
      initialWaitAfterAsOfSeq: 10,
      observedAsOfSeq: 12,
      asOfSeq: 12,
      tokenBudget: { maxTokens: 50_000_000 },
      disconnectBehavior: 'HOST_CONTINUES',
    })).toMatchObject({ accepted: true, runId: '22222222-2222-4222-8222-222222222222' })

    expect(() => taskAdmissionReceiptSchema.parse({
      schemaVersion: 1, accepted: true, runId: 'not-a-uuid', unexpected: true,
    })).toThrow()
  })
})

describe('structured MCP tool failures', () => {
  it('preserves Host connection failures as retryable HOST_FAILED envelopes', () => {
    expect(toolFailureEnvelope(new Error('could not connect to any configured DSH Host'))).toEqual({
      schemaVersion: 1,
      status: 'FAILED',
      failure: {
        kind: 'HOST_FAILED',
        message: 'could not connect to any configured DSH Host',
        retryable: true,
      },
    })
  })

  it('reports stale or invalid control failures as non-retryable protocol errors', () => {
    expect(toolFailureEnvelope(new Error('stale run old; active run is new'))).toMatchObject({
      status: 'FAILED',
      failure: { kind: 'PROTOCOL_ERROR', retryable: false },
    })
  })

  it('does not misclassify a reachable-Host session miss as a Host outage', () => {
    expect(toolFailureEnvelope(new Error(
      'session missing was not found on any reachable configured DSH Host',
    ))).toMatchObject({
      failure: { kind: 'PROTOCOL_ERROR', retryable: false },
    })
  })

  it('classifies partial Host discovery as retryable instead of claiming absence', () => {
    expect(toolFailureEnvelope(new HostDiscoveryError(
      'partial DSH Host discovery cannot conclude absence', ['http://offline'],
    ))).toMatchObject({
      failure: { kind: 'HOST_FAILED', retryable: true },
    })
  })

  it('classifies a reachable Host contract mismatch as non-retryable protocol failure', () => {
    expect(toolFailureEnvelope(new ProtocolContractError(
      'DSH Host does not expose atomic task admission',
    ))).toMatchObject({
      failure: { kind: 'PROTOCOL_ERROR', retryable: false },
    })
  })

  it('bounds failure text before returning it through MCP', () => {
    const envelope = toolFailureEnvelope(new Error(`DSH Host failed: ${'x'.repeat(4_000)}`))
    expect((envelope.failure as { message: string }).message).toHaveLength(2_048)
  })
})
