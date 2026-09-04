import { describe, expect, it } from 'vitest'
import { buildRecoveryCapsule, type RecoveryEvent, type RecoveryTaskPacket } from '../src/recovery.js'

const event = (type: string, seq: number, data: unknown): RecoveryEvent => ({ type, seq, time: seq, data })

describe('recovery capsule project activity', () => {
  it('retains Host Git changes and verification labels from a compound shell call', () => {
    const packet: RecoveryTaskPacket = {
      schemaVersion: 2,
      sessionId: 'session-1',
      runId: '11111111-1111-4111-8111-111111111111',
      objective: 'recover shell activity',
    }
    const events = [
      event('tool/call', 1, {
        callId: 'bash-1', name: 'bash',
        arguments: JSON.stringify({
          command: 'echo checking && test -s generated/report.md && git diff --check -- generated/report.md',
        }),
      }),
      event('tool/result', 2, {
        message: {
          source: { callId: 'bash-1' },
          content: [{ type: 'tool-result', isError: false, content: [] }],
        },
      }),
      event('tool/call', 3, {
        callId: 'handoff-1', name: 'supervisor_handoff', arguments: '{}',
      }),
      event('tool/result', 4, {
        message: {
          source: { callId: 'handoff-1' },
          content: [{ type: 'tool-result', isError: false, content: [{
            type: 'text',
            text: JSON.stringify({
              workspaceChanges: {
                source: 'HOST_GIT_BASELINE', total: 1,
                files: ['generated/report.md'], truncated: false,
              },
            }),
          }] }],
        },
      }),
    ]

    const capsule = buildRecoveryCapsule(packet, [{
      sessionId: packet.sessionId,
      events,
      activationSeq: 0,
      terminalSeq: 4,
      cwd: '/repo',
    }], 4)

    expect(capsule.workspace.activity).toMatchObject({
      edits: { total: 1, files: ['generated/report.md'] },
      verification: {
        total: 2,
        evidence: [
          { command: 'git diff --check', outcome: 'passed' },
          { command: 'test -s', outcome: 'passed' },
        ],
      },
    })
  })
})
