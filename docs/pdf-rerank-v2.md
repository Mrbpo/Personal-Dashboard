# PDF hybrid reranking: failure record and top-k correction

Issue #55. No production switch has occurred.

## Preserved run, not an acceptance pass

The public run from `2026-10-13T22:13:08Z` to `22:23:29Z` used a changing owner-wide corpus: new documents were being ingested under the same owner while the older corpus was queried. Newly published pages had not yet been vector-indexed. This invalidates the frozen-corpus acceptance conditions; the apparent Stanford 100% result is an observation, not a final acceptance result.

The original report is preserved, without modifying expectations:

- Archive: ignored `data/pdf-heldout/reports/hybrid-ai-20261013T222329Z-environment-invalid.json` in the heldout worktree.
- SHA256: `05d7f4d9728d4ce3ed203e7e4ebad78e32008f93d7eea69296ffd0f2b9bfa67f`.
- Across 300 outcomes: 33 `ai:invalid-output`, 34 `semantic:index-incomplete`, 4 combined incomplete/invalid, and 102 combined incomplete/budget-limit.
- The UTC-day ledger contains exactly 200 settled rerank requests, charged $1.45938975, and 139 settled embedding requests, charged $0.01399388. Rerank hit its existing daily 200-request limit. October total was $2.80225353 against $5; the monthly budget was not exhausted.
- This run persisted 92 valid v1 ordering cache entries. Raw responses and request-to-cache associations were not retained, so exact duplicate/missing-ID or repair counts cannot be reconstructed. The old report does not demonstrate a timeout, HTTP rate limit, or output-token truncation.

## Minimal change

Hybrid retrieval still presents up to 40 independently fused candidates. The v2 request selects only the requested first five distinct identities, rather than ordering all 40. The application validates exact count, uniqueness, membership and current evidence; it never invents an unvalidated result tail. The lexical guard only operates within that verified selection.

`document-page-selection-v2` and the selection count are included in the cache identity. Old full-order API/cache behavior remains available. Invalid output can receive one repair within the original 30-second window, under the same daily and monthly budgets. Diagnostic logs contain validation categories and attempt counts, without queries, original text, credentials or raw model responses.

The strict schema uses supported `minItems`/`maxItems` constraints. [Official OpenAI documentation](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses). `gpt-5-mini`, the 4,000-token allowance, and all budget policies remain unchanged; lower costs or better accuracy still require real measurement.

Three new mock tests passed, with no real API requests. Before the fresh three-group gate, finish ingestion and vector indexing for the entire frozen owner scope. Do not change that scope during querying, bypass limits, alter gold, or call this polluted run an acceptance pass.

## Review correction before the fresh gate

Strict library search could still match stale SQLite chunks after PostgreSQL published a reparse. Commit `da29fb6` removes those cached bodies from strict results while retaining filename-only metadata search. One new real PostgreSQL regression passed in an independent temporary schema (1/1, no old tests rerun and no model calls); type checking also passed. Current page results expose source hash and source-version identity for provenance checks.

The new corpus is fully parsed and indexed: 228 originals / 2,935 current original pages, including the fresh 121 originals / 1,070 pages and the old corpus as distractors. The fresh three-group run uses a frozen source/version/vector snapshot and the reviewed provenance gate. Its final accuracy results are pending; index completion is not a retrieval acceptance pass.
