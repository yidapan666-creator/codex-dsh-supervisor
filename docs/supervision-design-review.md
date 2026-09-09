# Supervision execution control review

Status: implemented locally for new reviewed runs using `execution-lease-v1`; deployment and provider smoke tests are not performed in this change. Existing historical runs retain their original contracts. This is not a full-system certification.

| ID | Structural issue | Current correction / remaining boundary |
| --- | --- | --- |
| S1 | Worker can omit its first review. | Host holds the first effect before execution. Codex sees AWAITING_GRANT and grants an already-established phase or returns Root to investigation. |
| S2 | Boolean approval has unlimited scope/lifetime. | Durable phase grants have tool/path capabilities, a ten-minute maximum lease, at most 64 effects and a monotonic generation. Semantic correctness inside an approved phase still requires Codex judgment. |
| S3 | Steer does not actually pause. | Explicit pause revokes new Root/child effects; the final native guard rejects stale reservations even after permissive middleware. In-flight effects cannot be undone. |
| S4 | allowedScope is not a preventive sandbox for arbitrary scripts. | Known file tools get path/link/type preflight checks. Narrow-scope scripts are denied. Residual: path preflight is not race-free backend confinement. |
| S5 | Cadence does not prove supervisor liveness. | Leases expire without renewal; paused/expired/restarted provider requests wait locally. Replacement MCP reads existing state. Codex is not automatically relaunched. |
| S6 | Worker completion is confused with supervisor acceptance. | record_review persists a separate supervisor declaration at an exact settled completion boundary. It is not proof of independent reasoning or a hash of workspace contents. |
| S7 | Build ID covers only the Host. | The build identity now includes MCP and packaged skills; new reviewed admissions require the execution contract. Residual: no hash proves which instructions an active Codex turn loaded. |
| S8 | Commands may trigger indirect files/network/hooks. | Only audited opaque backends may be explicitly granted under original full-cwd scope; capabilities report externalEffectConfinement=NOT_PROVIDED. Residual: network/hooks/background work need backend enforcement; an acknowledgement is not user permission. |

An additional composition correction prevents child-authored task markers from detaching a child from the Host's parent execution authority. Effectful children must use the canonical Root cwd. Root still owns child management; Codex controls the run-tree grant, not individual child implementation.

## State and persistence

- Investigation permits known read tools. Root review/progress/failure reporting and protocol-validated terminal handoff remain available.
- Proposals withdraw earlier authority. The supervisor grants the concrete phase, then answers the exact native question. A native Approve alone cannot release execution; revision/cancellation revokes a matching premature grant.
- Grant and renewal use compare-and-swap generations. An uncertain control result is reconciled with status; it is never blindly replayed.
- Files are atomically replaced and fsynced before acknowledgement. Each effect consumes its allowance before admission. I/O failure closes cached authority. Crash/cancellation does not recycle uncertain consumption.
- A new Host instance invalidates leases. Continuations begin without inherited authority. Existing recovery-capsule and uncertain-effect reconciliation rules remain binding.
- Pause prevents new effects. Tracked active calls are reported separately; zero tracked calls cannot prove all background processes stopped.

## Verification boundaries

Repository regression tests cover omitted reviews, pause/stale generation, expiry/provider waiting, concurrent allowances, persistence failure/restart, file/link preflight, automatic out-of-phase pause, independent declarations, admission compatibility, and MCP reconnect without redispatch. The native composition suite loads the pinned DSH tool scheduler when `DSH_NATIVE_CHECKOUT` is supplied (or a local checkout exists); it performs only temporary file effects and verifies Root/child gating and late permissive-policy rejection. A missing native checkout skips these probes and must be reported, not counted as native coverage.

No provider task is needed for these checks. Live deployment remains a separate acceptance step: load matching Host/MCP/skills with session state reconciled, then verify the Web question, bounded grant and correction flow on an explicitly authorized task. This change does not restart either local Host or Codex, publish a release, or silently upgrade an existing session's contract.

## Local verification result — 2026-09-09

- Final temporary-copy workspace build, typecheck and full suite: **30 files, 394/394 tests passed**.
- Included **3 pinned native scheduler composition tests** and **1 authenticated HTTP round-trip test** on an isolated ephemeral loopback port; no provider was invoked.
- Git whitespace validation and source build identity check passed. Skill frontmatter was parsed and checked with Ruby YAML; the optional Python skill validator could not run because PyYAML is absent.
- New scope/authority behavior is not deployed. No live Host/Codex restart, provider smoke test, commit, push or release was performed. Runtime tests used temporary files and a synthetic credential; production credentials were not inspected.
