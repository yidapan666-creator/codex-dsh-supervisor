# Decision policy and standalone RAG research

Status: first implementation and research baseline, 2026-08-26.

Update: the runtime now persists one model-free structured record for each
durable terminal run through `@dsh-gate/run-journal`. These records are the
canonical future retrieval source; `rag-context` can convert them into overview,
change, decision, and verification chunks, but no retrieval result is injected
into a task or wait response yet.

## Executive decision

The supervisor should not encode every intervention as a branch in `dsh_wait`.
It now separates two kinds of behavior:

1. **Protocol invariants** are locked: pending approvals/questions, checkpoints,
   terminal success/failure, and protocol/Host failures remain immediate. In
   particular, completion still requires a valid handoff plus its matching turn
   end.
2. **Worker decision requests** are policy-controlled from structured facts:
   category, impact, blocking state, whether a human is explicitly required,
   and task-packet pre-authorization. The result contains timing, audience,
   action, matched rule, reason code, and policy version.

This follows the useful boundary in Open Policy Agent—policy decisions consume
structured input while enforcement stays in the host application—and Cedar's
emphasis on explicit policies, default-deny behavior, validation, and decision
diagnostics. It does not add either runtime as a dependency: the current rule
surface is small enough for a pure, typed package.

Sources: [OPA documentation](https://www.openpolicyagent.org/docs),
[Cedar authorization](https://docs.cedarpolicy.com/auth/authorization.html),
[Cedar schema validation](https://docs.cedarpolicy.com/schema/schema.html).

## Decision flow

```text
DSH runtime event / supervisor_progress
               |
               v
       normalized decision facts
               |
               v
  locked protocol effect OR prioritized worker rule
               |
               v
 timing + audience + action + reason + policy version
               |
        +------+------+
        |             |
     cadence       immediate
   dsh_wait fold   dsh_wait return
```

The default worker policy is intentionally conservative:

- explicit human requests and sensitive categories go to the human immediately;
- sensitive means security, destructive action, credentials, external side
  effect, requested scope, or acceptance criteria;
- task-packet pre-authorization can suppress routine architecture/recovery
  interruptions, but never sensitive or explicitly human requests;
- other high-impact requests go to the human;
- other blocking requests go to the supervisor;
- low/medium non-blocking requests are reported on the normal cadence.

`needsSupervisor` remains a migration hint for old workers. New workers attach a
structured `decision` object. Only Codex's durable task packet may declare
`preAuthorizedDecisionCategories`; the worker cannot self-authorize.

Operators select immutable JSON policies from `config/decision-policies/`.
Every new run durably pins the active version and canonical SHA-256 digest; an
MCP restart must resolve the same catalog entry or fail closed. The explain/dry-
run CLI reports matched rules for supplied facts. An optional pinned shadow
policy is evaluated by the same engine and recorded for comparison while active
timing/action remains authoritative. `DSH_DECISION_POLICY_JSON` is retained only
for migration.

## Why RAG is separate

Retrieval-augmented generation combines retrieved external knowledge with a
generator. The original RAG work established the general approach; repository
work since then shows that code retrieval needs repository-aware context and
must be evaluated separately from the generator.

- RepoCoder uses iterative repository retrieval and generation rather than only
  the local file context. [RepoCoder, EMNLP 2023](https://aclanthology.org/2023.emnlp-main.151/)
- Repoformer argues for selective retrieval instead of paying retrieval cost on
  every completion. [Repoformer](https://arxiv.org/abs/2403.10059)
- CodeRAG-Bench evaluates both retrieval quality and whether generators use the
  retrieved context effectively; improving retrieval alone does not guarantee a
  better end result. [CodeRAG-Bench](https://aclanthology.org/2025.findings-naacl.176/)
- Reciprocal Rank Fusion combines rankings without assuming their raw scores are
  comparable. [Original RRF research](https://research.google/pubs/reciprocal-rank-fusion-outperforms-condorcet-and-individual-rank-learning-methods/)
- Late-interaction retrieval such as ColBERT is a plausible later semantic
  adapter when the lexical baseline has a benchmark. [ColBERT](https://arxiv.org/abs/2004.12832)

The new `@dsh-gate/rag-context` package therefore provides only:

- stable chunk/source contracts, including URI, commit, path, symbol and lines;
- a replaceable asynchronous `Retriever` port;
- deterministic identifier-aware lexical/BM25-style retrieval;
- commit/language/path filtering and a conservative estimated context budget;
- rank-fusion primitives for future lexical, symbol and semantic channels.

It is **not connected** to MCP, `dsh_task`, `dsh_wait`, the decision package, or
the DSH worker. It has no embedding/model/network/vector-database dependency and
performs no automatic context injection.

## Deferred RAG roadmap and acceptance gates

1. Add a repository indexer with language-aware symbol chunks, content hashes,
   commit versioning, incremental deletion, and path/symlink containment.
2. Build a frozen benchmark from real dsh-gate tasks. Measure Recall@k and MRR
   (or nDCG), then end-to-end acceptance/test pass rate, retrieved-token cost,
   latency, freshness, and citation correctness.
3. Add an optional semantic or late-interaction adapter; fuse it with lexical and
   symbol rankings through RRF. Keep exact provenance on every hit.
4. Add selective retrieval policy only after measuring when retrieval helps.
5. Connect retrieval to task construction only after explicit context-budget,
   prompt-injection, data-boundary, freshness, and failure-fallback reviews.

Microsoft GraphRAG is intentionally deferred. Its indexing pipeline adds
LLM-based extraction, graphs, communities and reports—useful for global thematic
questions over large corpora, but disproportionate to this repository's first
code-context baseline. [GraphRAG architecture](https://microsoft.github.io/graphrag/index/architecture/)

The original RAG paper remains the conceptual provenance for combining retrieval
with generation: [Retrieval-Augmented Generation](https://arxiv.org/abs/2005.11401).
