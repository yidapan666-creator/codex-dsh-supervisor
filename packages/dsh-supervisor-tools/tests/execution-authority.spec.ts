import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExecutionAuthority, MemoryExecutionStore, FileExecutionStore, effectCovered } from '../src/execution-authority.js'

const sessionId = 'root'
const runId = '11111111-1111-4111-8111-111111111111'
const address = { sessionId, runId }
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
const grant = (authority: ExecutionAuthority, expectedGeneration = 0) => authority.control({ ...address, action: 'grant', expectedGeneration, phase: 'CORE: implement doneWhen 0', paths: ['src'], leaseMs: 1000, maxEffects: 2 }, ['src'], true)

describe('Host-owned bounded execution authority', () => {
  it('omitted review waits before effects; explicit grant releases it without another provider', async () => {
    const a = new ExecutionAuthority(new MemoryExecutionStore())
    const token = Symbol(); const abort = new AbortController()
    let invoked = false
    const pending = a.enter(sessionId, runId, token, abort.signal, async () => true).then(allowed => { invoked = allowed })
    await tick()
    expect(invoked).toBe(false)
    expect((await a.inspect(sessionId, runId)).status).toBe('AWAITING_GRANT')
    await grant(a); await pending
    expect(invoked).toBe(true); expect(a.permits(token)).toBe(true)
    expect((await a.inspect(sessionId, runId)).remainingEffects).toBe(1)
    a.finish(token)
  })
  it('pause invalidates already-reserved effects and rejects late grants by generation', async () => {
    const a = new ExecutionAuthority(new MemoryExecutionStore()); await grant(a)
    const token = Symbol()
    expect(await a.enter(sessionId, runId, token, new AbortController().signal, async () => true)).toBe(true)
    await a.control({ ...address, action: 'pause', expectedGeneration: 1 }, ['src'], true)
    expect(a.permits(token)).toBe(false)
    expect((await a.inspect(sessionId, runId)).activeEffects).toBe(1)
    await expect(grant(a, 1)).rejects.toThrow('stale')
    a.finish(token)
    expect((await a.inspect(sessionId, runId)).activeEffects).toBe(0)
  })
  it('expiry blocks the provider until explicit renewed judgment; no polling model call', async () => {
    let now = 1000; const a = new ExecutionAuthority(new MemoryExecutionStore(), () => now)
    await grant(a); now = 2001
    let provider = false; const abort = new AbortController()
    const waiting = a.waitProvider(sessionId, runId, abort.signal).then(() => { provider = true })
    await tick(); expect(provider).toBe(false)
    await expect(a.control({ ...address, action: 'renew', expectedGeneration: 1 }, ['src'], true)).rejects.toThrow('live grant')
    await grant(a, 1); await waiting; expect(provider).toBe(true)
  })
  it('concurrent root/child effects cannot spend the same allowance', async () => {
    const a = new ExecutionAuthority(new MemoryExecutionStore()); await grant(a)
    const abort = new AbortController(); const tokens = [Symbol(), Symbol(), Symbol()]
    const results: boolean[] = []
    const pending = tokens.map(token => a.enter(sessionId, runId, token, abort.signal, async () => true).then(v => results.push(v)).catch(() => {}))
    await tick(); expect(results).toEqual([true, true]); expect((await a.inspect(sessionId, runId)).remainingEffects).toBe(0)
    abort.abort(); await Promise.all(pending)
  })
  it('persists allowance before permitting execution and fails closed on I/O errors', async () => {
    const store = new MemoryExecutionStore(); const a = new ExecutionAuthority(store); await grant(a)
    store.write = async () => { throw new Error('disk failure') }
    const token = Symbol()
    await expect(a.enter(sessionId, runId, token, new AbortController().signal, async () => true)).rejects.toThrow('disk failure')
    expect(a.permits(token)).toBe(false)
    await expect(a.inspect(sessionId, runId)).rejects.toThrow('persistence failed')
  })
  it('restart preserves history but invalidates the lease; another MCP shares existing generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'execution-ledger-'))
    try {
      const a = new ExecutionAuthority(new FileExecutionStore(directory)); await grant(a)
      expect((await a.inspect(sessionId, runId)).generation).toBe(1)
      const b = new ExecutionAuthority(new FileExecutionStore(directory))
      expect((await b.inspect(sessionId, runId)).status).toBe('RESTARTED')
      expect((await b.inspect(sessionId, '22222222-2222-4222-8222-222222222222')).status).toBe('INVESTIGATING')
      await grant(b, 1); expect((await b.inspect(sessionId, runId)).status).toBe('GRANTED')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('revise returns a waiting effect once for investigation; worker proposals cannot unpause', async () => {
    const a = new ExecutionAuthority(new MemoryExecutionStore()); const abort = new AbortController()
    const pending = a.enter(sessionId, runId, Symbol(), abort.signal, async () => true)
    await tick(); await a.control({ ...address, action: 'revise', expectedGeneration: 0 }, ['src'], true)
    expect(await pending).toBe(false)
    await a.control({ ...address, action: 'pause', expectedGeneration: 1 }, ['src'], true)
    await a.proposal(sessionId, runId)
    expect((await a.inspect(sessionId, runId)).status).toBe('PAUSED')
  })
  it('automatically pauses an out-of-phase effect instead of returning a retry loop to the provider', async () => {
    const a = new ExecutionAuthority(new MemoryExecutionStore()); await grant(a)
    const pending = a.enter(sessionId, runId, Symbol(), new AbortController().signal, async () => false)
    await tick()
    expect(await a.inspect(sessionId, runId)).toMatchObject({ status: 'PAUSED', generation: 2, waitingEffects: 1 })
    await a.control({ ...address, action: 'revise', expectedGeneration: 2 }, ['src'], true)
    expect(await pending).toBe(false)
  })

  it('keeps independent supervisor declarations durable and separate from worker success', async () => {
    const store = new MemoryExecutionStore(); const a = new ExecutionAuthority(store)
    expect((await a.inspect(sessionId, runId)).independentReview).toBeUndefined()
    await a.control({ ...address, action: 'record_review', expectedGeneration: 0, verdict: 'ACCEPTED', asOfSeq: 99, evidence: 'Inspected actual change; independent focused validation passed.' }, [], true)
    const restarted = new ExecutionAuthority(store)
    expect((await restarted.inspect(sessionId, runId)).independentReview).toMatchObject({ verdict: 'ACCEPTED', asOfSeq: 99, source: 'SUPERVISOR_DECLARATION' })
  })

  it('does not grant shell or escalation under a narrow path scope; read-only cannot gain writes', async () => {
    const a = new ExecutionAuthority(new MemoryExecutionStore())
    await expect(a.control({ ...address, action: 'grant', expectedGeneration: 0, phase: 'test', opaqueTools: ['bash'], acknowledgeUnconfinedEffects: true }, ['src'], true)).rejects.toThrow('full-cwd')
    await expect(a.control({ ...address, action: 'grant', expectedGeneration: 0, phase: 'edit', paths: ['src'] }, ['src'], false)).rejects.toThrow('read-only')
    await expect(a.control({ ...address, action: 'grant', expectedGeneration: 0, phase: 'edit', paths: ['other'] }, ['src'], true)).rejects.toThrow('out-of-scope')
  })
  it('checks actual paths, links, scope, and unknown tools before granting known file effects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'execution-paths-'))
    try {
      await mkdir(join(directory, 'src')); await writeFile(join(directory, 'src/a'), 'a')
      await symlink('a', join(directory, 'src/sym')); await link(join(directory, 'src/a'), join(directory, 'src/hard'))
      const a = new ExecutionAuthority(new MemoryExecutionStore()); const state = await grant(a)
      for (const file_path of ['/tmp/a', '../a', 'other/a', 'src/sym', 'src/hard', 'src']) {
        expect(await effectCovered(state, directory, 'write', { file_path })).toBe(false)
      }
      expect(await effectCovered(state, directory, 'write', { file_path: 'src/new' })).toBe(true)
      expect(await effectCovered(state, directory, 'write', { file_path: 'src/new', sandbox_permissions: 'require_escalated' })).toBe(false)
      expect(await effectCovered(state, directory, 'bash', { command: 'echo test' })).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
