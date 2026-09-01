import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function requiredHostToken(): string {
  const token = process.env.DSH_HOST_TOKEN?.trim()
  if (token === undefined || token.length < 32) {
    throw new Error('dsh-gate supervisor tools require DSH_HOST_TOKEN with at least 32 characters')
  }
  return token
}

/** Bearer and browser-origin boundary for plugin-owned exact HTTP routes. */
export function authorizeSupervisorRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const expected = process.env.DSH_HOST_TOKEN?.trim()
  // Standalone unit compositions may omit auth; production apply() requires it.
  if (expected === undefined) return true
  const authorization = req.headers.authorization
  const supplied = authorization?.startsWith('Bearer ') === true
    ? authorization.slice('Bearer '.length)
    : undefined
  const host = req.headers.host
  const origin = req.headers.origin
  let trustedOrigin = req.headers['sec-fetch-site'] !== 'cross-site'
  if (trustedOrigin && origin !== undefined) {
    try {
      trustedOrigin = host !== undefined && new URL(origin).host === new URL(`http://${host}`).host
    } catch {
      trustedOrigin = false
    }
  }
  if (trustedOrigin && supplied !== undefined && sameSecret(supplied, expected)) return true
  res.writeHead(401, { 'cache-control': 'no-store', 'www-authenticate': 'Bearer' })
  res.end('unauthorized')
  return false
}
