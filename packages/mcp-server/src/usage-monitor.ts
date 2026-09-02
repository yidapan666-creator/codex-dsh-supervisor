export interface UsageMonitorObservation {
  source: 'dsh-usage-monitor'
  authoritativeForBudget: false
  available: boolean
  found: boolean
  scope: 'session_lifetime'
  includesDescendants: false
  sessionRawTokens?: number
  requestCount?: number
  warning?: string
}

interface MonitorSession {
  sessionId?: unknown
  rawTokens?: unknown
  requestCount?: unknown
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** Optional read-only bridge to dsh-usage-monitor. It never controls enforcement. */
export class UsageMonitorClient {
  readonly baseUrl: string

  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = new URL(baseUrl).origin
  }

  async observeSession(sessionId: string): Promise<UsageMonitorObservation> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/sessions`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(1_500),
      })
      if (!response.ok) throw new Error(`HTTP_${response.status}`)
      const value = await response.json() as unknown
      if (!Array.isArray(value)) throw new Error('INVALID_RESPONSE')
      const row = value.find((candidate): candidate is MonitorSession =>
        typeof candidate === 'object' && candidate !== null
        && (candidate as MonitorSession).sessionId === sessionId)
      const sessionRawTokens = row === undefined ? undefined : nonnegativeInteger(row.rawTokens)
      const requestCount = row === undefined ? undefined : nonnegativeInteger(row.requestCount)
      return {
        source: 'dsh-usage-monitor',
        authoritativeForBudget: false,
        available: true,
        found: row !== undefined,
        scope: 'session_lifetime',
        includesDescendants: false,
        ...sessionRawTokens === undefined ? {} : { sessionRawTokens },
        ...requestCount === undefined ? {} : { requestCount },
      }
    } catch (error) {
      const code = error instanceof Error && error.name === 'TimeoutError'
        ? 'TIMEOUT'
        : error instanceof Error ? error.message.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 64) : 'UNAVAILABLE'
      return {
        source: 'dsh-usage-monitor',
        authoritativeForBudget: false,
        available: false,
        found: false,
        scope: 'session_lifetime',
        includesDescendants: false,
        warning: `optional usage monitor unavailable (${code})`,
      }
    }
  }
}
