import { describe, expect, it } from 'vitest'
import {
  DSH_GATE_DESCRIPTOR_PATH,
  WEB_AUTH_GUARD_ID,
  webAuthGuardInjections,
} from '../src/index.js'

describe('DSH Web authentication guard', () => {
  it('injects a visible fail-closed guard without embedding a credential', () => {
    const rows = webAuthGuardInjections()
    expect(rows.map(row => row.kind)).toEqual(['style', 'html', 'script'])
    expect(JSON.stringify(rows)).toContain(WEB_AUTH_GUARD_ID)
    expect(JSON.stringify(rows)).toContain(DSH_GATE_DESCRIPTOR_PATH)
    expect(JSON.stringify(rows)).toContain('browserUrl')
    expect(JSON.stringify(rows)).toContain('dsh_token')
    expect(JSON.stringify(rows)).not.toContain('Bearer a')
  })

  it('keeps structured injection payloads safe for index rendering', () => {
    const rows = webAuthGuardInjections()
    const style = rows.find(row => row.kind === 'style')
    const script = rows.find(row => row.kind === 'script')
    expect(style?.kind === 'style' ? style.text : '').not.toMatch(/<\/style/i)
    expect(script?.kind === 'script' ? script.text : '').not.toMatch(/<\/script/i)
  })
})
