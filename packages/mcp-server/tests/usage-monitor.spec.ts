import { describe, expect, it, vi } from 'vitest'
import { UsageMonitorClient } from '../src/usage-monitor.js'

describe('optional dsh-usage-monitor bridge', () => {
  it('reads only token/session counters and marks them non-authoritative', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([
      { sessionId: 's1', rawTokens: 1234, requestCount: 7, estimatedCost: 999 },
    ]), { status: 200 })) as unknown as typeof fetch
    const client = new UsageMonitorClient('http://127.0.0.1:41999', fetcher)
    await expect(client.observeSession('s1')).resolves.toEqual({
      source: 'dsh-usage-monitor',
      authoritativeForBudget: false,
      available: true,
      found: true,
      scope: 'session_lifetime',
      includesDescendants: false,
      sessionRawTokens: 1234,
      requestCount: 7,
    })
  })

  it('distinguishes a missing session row from monitor downtime', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch
    const client = new UsageMonitorClient('http://127.0.0.1:41999', fetcher)
    await expect(client.observeSession('missing')).resolves.toMatchObject({
      available: true, found: false, scope: 'session_lifetime', includesDescendants: false,
    })
  })

  it('contains bridge failure without affecting the run', async () => {
    const fetcher = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    const client = new UsageMonitorClient('http://127.0.0.1:41999', fetcher)
    await expect(client.observeSession('s1')).resolves.toMatchObject({
      available: false,
      found: false,
      authoritativeForBudget: false,
      warning: expect.stringContaining('unavailable'),
    })
  })
})
