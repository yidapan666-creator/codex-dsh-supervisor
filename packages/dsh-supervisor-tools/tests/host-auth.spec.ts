import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizeSupervisorRequest, requiredHostToken } from '../src/host-auth.js'

const TOKEN = 'a'.repeat(32)
const original = process.env.DSH_HOST_TOKEN

afterEach(() => {
  if (original === undefined) delete process.env.DSH_HOST_TOKEN
  else process.env.DSH_HOST_TOKEN = original
})

function response(): { res: ServerResponse; status: () => number; body: () => string } {
  let code = 0
  let value = ''
  return {
    res: {
      writeHead(next: number) { code = next; return this },
      end(chunk?: string) { value += chunk ?? ''; return this },
    } as unknown as ServerResponse,
    status: () => code,
    body: () => value,
  }
}

describe('Host supervisor route authentication', () => {
  it('fails plugin startup closed without a strong deployment token', () => {
    delete process.env.DSH_HOST_TOKEN
    expect(() => requiredHostToken()).toThrow(/require DSH_HOST_TOKEN/)
    process.env.DSH_HOST_TOKEN = 'short'
    expect(() => requiredHostToken()).toThrow(/at least 32/)
  })

  it('accepts an exact bearer credential from a non-browser client', () => {
    process.env.DSH_HOST_TOKEN = TOKEN
    const reply = response()
    const req = { headers: { authorization: `Bearer ${TOKEN}` } } as IncomingMessage
    expect(authorizeSupervisorRequest(req, reply.res)).toBe(true)
    expect(reply.status()).toBe(0)
  })

  it('rejects absent, wrong, and cross-site browser credentials', () => {
    process.env.DSH_HOST_TOKEN = TOKEN
    for (const headers of [
      {},
      { authorization: `Bearer ${'b'.repeat(32)}` },
      { authorization: `Bearer ${TOKEN}`, 'sec-fetch-site': 'cross-site' },
      { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:8080', origin: 'https://attacker.example' },
    ]) {
      const reply = response()
      expect(authorizeSupervisorRequest({ headers } as IncomingMessage, reply.res)).toBe(false)
      expect(reply.status()).toBe(401)
      expect(reply.body()).toBe('unauthorized')
    }
  })
})
