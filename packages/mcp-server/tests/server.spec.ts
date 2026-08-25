import { describe, expect, it } from 'vitest'
import { toolFailureEnvelope } from '../src/server.js'

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
})
