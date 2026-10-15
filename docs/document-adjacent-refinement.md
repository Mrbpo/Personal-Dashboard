# Adjacent PDF evidence refinement

`KernelService.searchDocumentText(owner, query, {hybrid:true, aiRerank:true,
refineAdjacent:true})` opts into a second selection stage. The default stays
disabled. Strict or non-hybrid/non-AI retrieval cannot enable it.

The first stage keeps its original 40 candidates, five-page selection, lexical
protection, prompt, query embedding and cache identity. After that stage has
selected actual current evidence, Kernel retains its at most five pages and
supplements them with one unselected dense candidate and one distinct unselected
lexical candidate meeting the unchanged `0.5` support threshold. Already selected
pages and the dense supplement cannot consume the lexical supplement slot;
it continues to the next eligible lexical page. Both supplements must belong to
the verified original 40-page input with matching source/version/evidence and
course metadata. No title, file suffix or new recall query determines eligibility.
After current owner/source validation, valid non-PDF or time-segment supplements
are skipped using stored source MIME and content kind; stale or foreign identities
still fail. This preserves mixed forum/PDF/text search behavior.

Kernel reads each actual seed's immediate previous and next physical PDF pages.
The original five anchors are the unchanged
first-stage results after existing lexical protection, not a claim that its
protected fifth page was the model's native fifth selection. Only nonempty,
same-version stored evidence is eligible. MIME comes from the current source version's
original metadata; paragraph collections and time segments are not treated as
physical PDF pages. Neighbor reads bind owner, course, source hash/version,
evidence, parser, document metadata and newest visible origin.

The selected pages remain in the refinement pool, in original selection order;
verified supplements and deduplicated neighbors follow. Original five pages
cannot be replaced by the supplement selection. At most seven seeds produce
at most 21 pages. Only a pool with additional evidence triggers selection, returning at most five
actual pages. No synthetic pages, changed transcription or extra embedding
request are involved. Normal parser warnings and final full-page hydration
remain applicable. The model input still uses the existing 6000-codepoint page
limit; stored original bodies are preserved.

The second stage has prompt version `document-page-adjacent-refinement-v2-independent-seeds` and
Responses schema name `document_page_refinement`. Its candidate-specific cache
is separate from the initial `document-page-selection-v3-context` namespace.
Model, effort and output limit use the same internal run policy; second-stage
provider work permits one attempt, including when ordinary work permits a
repair. Unchanged initial caches remain reusable; historical v1 refinement rows
cannot be used as v2 results, even when a candidate list happens to match. New v2
successes are cached against their actual ordered candidate identities and bodies. Failed work
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
first-stage document/page/source-version/evidence identities, unchanged by the
supplements. `refinement_seeds` separately records the original anchors plus the
actual eligible supplements; skipped non-PDF results are absent. A skipped stage's
candidate count equals its actual first-stage count. Model diagnostics describe
the stage that returned the final selection. Errors retain the existing
explicit keyword-fallback behavior; a fallback is not a successful refinement.

No query ID, source title, expected page or answer key configures this algorithm.
Mocked contract and isolated PostgreSQL checks establish scope, cache and API
behavior, not retrieval accuracy. Existing mini runs remain 147/150 designated
physical-page Top5 (A49/B50/C48); historical C50 Astra is separate. A seen offline
counterfactual restored candidate opportunity for two failures, not proven final
Top5 improvement, and C11 remains unresolved. No new paid run is part of this
change. Any later small calibration needs its own frozen scope, cap and explicit
execution authorization; retain completed model outputs instead of automatically
rerunning passed work. Three distinct complete document/PDF acceptance states
remain an independent delivery requirement. Merge and CI do not deploy code or
switch production.
