import { describe, expect, it } from 'vitest'
import { toolFailureEnvelope } from '../src/server.js'
import { HostDiscoveryError } from '../src/gateway.js'
import { ProtocolContractError } from '../src/host.js'

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
