# Development study-answer planning

Issue #133 adds only the first phase of a complete-answer pipeline. `KernelService.planStudyAnswer(owner, query, {courseId?}, policy)` performs real library retrieval and proposes answer requirements, evidence clusters and scope/conflict distinctions. It does not generate answers, execute supplemental queries, audit claims or revise citations. It is not connected to UI, application routes or production defaults.

## Input and source boundary

The fixed method is keyword search with `relatedDocuments=true`, limit14, current full evidence, section parents, and original verified images under the existing shared image budget. Semantic retrieval, embeddings, hybrid search and AI reranking are disabled in this development lane. A public title may be part of the natural query. `documentId`, `paperId`, `sourceHint` and other hidden source filters are rejected; an optional course must come from explicit user context. This is not equivalent to the old hybrid PDF retrieval benchmark.

The context callback is the extracted existing `answerStudyContent` callback. Default answering retains its options, source reads, provider request and behavior. Every planning recheck uses those same current source/evidence identities; a change fails the attempt. Parser warnings, unavailable parents and omitted-image accounting remain in the request and receipt. The supplied context is not claimed to cover the entire library.

## Plan

- `requirements`: all material question aspects with `requestedScope` (subject, attribute, unit, population, stage, configuration, time). Unknown dimensions are null.
- `clusters`: requirement IDs, actual selectable q/image IDs, separate source-grounded `groundedScope`, and sufficient/needs-evidence/ambiguous status. An asserted grounded scope needs source evidence. Metadata eN/supportId are not selectable.
- `conflicts`: two different clusters, evidence on both sides, same-context/different-context/unresolved comparability and a reason. Each side must cite its own cluster evidence; a source cannot be silently substituted.
- `missing`: preserved requirement, reason, and optional lexical supplement query. Nothing executes it in this phase.

Every requirement must have a cluster or a missing entry. Shared schema definitions list real source IDs once. Structural validation is not semantic proof. A valid plan returns `ready-for-review`, `needs-evidence`, `incomplete-context` or `capacity-exceeded`. The pilot permits at most six clusters to advance; a larger plan is retained intact and reported incomplete. `semanticVerified` and `wholeAnswerVerified` remain false in all cases. A refusal or smaller plan cannot establish complete-answer accuracy.

## Paid boundary and future phases

Planning requires the existing isolated development policy, ordinary ledger with bypass explicitly false, frozen mini54 rates/context, and mandatory durable `beforeAttempt`/`recordResponse` functions. There is at most one gpt-5.4-mini low/4000/30s request per invocation, with no retry or upgrade. The actual complete request, schema, image token bound and framing must fit the existing300k input cap before reservation. The attempt exposes both the real input/usage bound and the ordinary full-body `/2` reservation bound; callers must fund their maximum and enforce a batch cap. Raw response bytes are journaled before diagnostic parsing and retained on model/schema/usage/source failure. Ambiguous timeouts retain ordinary reservations.

The six exposed query-only inputs remain ignored operational artifacts, separately frozen and subject to coordinator execution approval. Initially only six retrieval plans may be reviewed for paid execution; there is no authorization from this document. No existing answer/Gold/score is changed. Later per-cluster generation, optional bounded supplement/finalization, and physically isolated per-claim audit need separate actual-body and total-call budgets. A per-cluster cap cannot bound auditing unless the number of produced claims is also frozen. No whole-source self-audit from the closed PR130 is reused.

Plan calibration is not the final goal. Three independent complete learning-oriented material/question sets, multi-source retrieval, useful complete answers, applicable citations and source text/formula/table fidelity still require separate acceptance. Code/CI, service deployment and production switching are distinct delivery states.
