# Adjacent PDF evidence refinement

`KernelService.searchDocumentText(owner, query, {hybrid:true, aiRerank:true,
refineAdjacent:true})` opts into a second selection stage. The default stays
disabled. Strict or non-hybrid/non-AI retrieval cannot enable it.

The first stage keeps its original 40 candidates, five-page selection, lexical
protection, prompt, query embedding and cache identity. After that stage has
selected actual current evidence, Kernel reads each of its at most five pages'
immediate previous and next physical PDF pages. The anchors are the unchanged
first-stage results after existing lexical protection, not a claim that its
protected fifth page was the model's native fifth selection. Only nonempty,
same-version stored evidence is eligible. MIME comes from the current source version's
original metadata; paragraph collections and time segments are not treated as
physical PDF pages. Neighbor reads bind owner, course, source hash/version,
evidence, parser, document metadata and newest visible origin.

The selected pages remain in the refinement pool, in original selection order;
deduplicated neighbors follow. The pool has at most 15 pages. Only a pool with
at least one additional neighbor triggers selection, returning at most five
actual pages. No synthetic pages, changed transcription or extra embedding
request are involved. Normal parser warnings and final full-page hydration
remain applicable. The model input still uses the existing 6000-codepoint page
limit; stored original bodies are preserved.

The second stage has prompt version `document-page-adjacent-refinement-v1` and
Responses schema name `document_page_refinement`. Its candidate-specific cache
is separate from the initial `document-page-selection-v3-context` namespace.
Model, effort and output limit use the same internal run policy; second-stage
provider work permits one attempt, including when ordinary work permits a
repair. Successful initial and refinement caches remain reusable. Failed work
cannot silently trigger another paid attempt under a persistent administrator
journal.

`beforeAttempt(cacheIdentity, metadata?)` preserves the original first argument.
For uncached work its metadata contains `phase` (`initial` or
`adjacent-refinement`), `promptVersion` and `candidateCount`. It runs before
provider reservation. An acceptance harness can therefore prohibit any initial
cache miss and durably journal each refinement cache identity before payment.
Cache hits invoke neither this hook nor the provider. The administrator must
retain this journal across process restarts; code does not reset the ledger.

Returned hit diagnostics are `refinement_mode` (`adjacent-pages` or
`no-new-neighbors`), `refinement_candidate_count`, and `refined_from`: the actual
first-stage document/page/source-version/evidence identities. A skipped stage's
candidate count equals its actual first-stage count. Model diagnostics describe
the stage that returned the final selection. Errors retain the existing
explicit keyword-fallback behavior; a fallback is not a successful refinement.

No query ID, source title, expected page or answer key configures this algorithm.
Mocked contract and isolated PostgreSQL checks establish scope, cache and API
behavior, not retrieval accuracy. First verify the three original failed cases
with cached initial stages, then run the necessary full final-algorithm cohort
to detect regressions. Three distinct complete document/PDF acceptance states
remain an independent delivery requirement. Merge and CI do not deploy code or
switch production.
