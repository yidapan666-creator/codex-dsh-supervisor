import { describe, it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ExecutionAuthority, MemoryExecutionStore, registerExecutionRoute } from '../../dsh-supervisor-tools/src/execution-authority.js'
import { postExecutionControl } from '../src/execution-control.js'

describe('authenticated execution control HTTP composition (isolated fixture)', () => {
  it('uses the same Host state across transport replacement and rejects stale and unauthenticated control', async () => {
    const credential = 'synthetic-execution-fixture-credential'
    vi.stubEnv('DSH_HOST_TOKEN', credential)
    const a = new ExecutionAuthority(new MemoryExecutionStore())
    let handler!: Parameters<Parameters<typeof registerExecutionRoute>[0]['register']>[0]['handler']
    registerExecutionRoute({ register(route) { handler = route.handler; return () => {} } }, command => a.control(command, ['.'], true))
    const server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const address = { sessionId: 'fixture', runId: '11111111-1111-4111-8111-111111111111' }
    try {
      expect(await postExecutionControl(base, { ...address, action: 'status' }, credential)).toMatchObject({ generation: 0, status: 'INVESTIGATING' })
      await expect(postExecutionControl(base, { ...address, action: 'grant', expectedGeneration: 0, phase: 'W1: edit', paths: ['.'] }, 'incorrect-fixture-credential')).rejects.toThrow('rejected')
      expect(await postExecutionControl(base, { ...address, action: 'grant', expectedGeneration: 0, phase: 'W1: edit', paths: ['.'] }, credential)).toMatchObject({ generation: 1, status: 'GRANTED' })
      expect(await postExecutionControl(base, { ...address, action: 'status' }, credential)).toMatchObject({ generation: 1, phase: 'W1: edit' })
      await expect(postExecutionControl(base, { ...address, action: 'grant', expectedGeneration: 0, phase: 'old' }, credential)).rejects.toThrow('rejected')
      expect(await postExecutionControl(base, { ...address, action: 'pause', expectedGeneration: 1 }, credential)).toMatchObject({ generation: 2, status: 'PAUSED' })
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs() }
  })
})
