# Unified content tags and retrieval routing — Issue193

## First slice: metadata observations, default off

The existing `KernelService.ingestParsedDocument` is shared by indexed Canvas resources/announcements, Piazza text, imported mail bodies/attachments, PDFs and recording transcripts. Opt-in `KERNEL_CONTENT_TAGS=metadata-v1` classifies its stored source metadata in the same PostgreSQL transaction as evidence and the current document-version pointer. Default `off` preserves ingestion behavior; invalid modes fail before source writes. No model call, parse request, embedding or search change occurs.

`content-tags.ts` defines `academic-content-tags-v1` and `source-metadata-rules-v1`. Facets are course, term, source, format, document_type, topic, chapter and assignment. Stable tag identities include taxonomy/facet/key. Source aliases and document-type rules are controlled code under that producer version; changing them requires a new version. Course and term keys reuse PostgreSQL IDs.

An assignment records exact metadata witnesses, method, confidence, document scope and routing use. `identity-only` describes an observed field; it does **not** authorize a hard relevance filter. Confidence1 means exact metadata observation, not that the course association or content is semantically verified. Filename/type predictions are always `soft-only` and can coexist. Semantic facets not implemented in this slice remain explicitly unknown. Tags do not become facts, dates, answer evidence or citation IDs.

Migration015 adds immutable-by-writer `document_tag_sets` snapshots with source/document/version/owner/hash binding, metadata and classification digests, unknown facets and a GIN tag index. Composite foreign keys prevent cross-owner/source/version combinations. This additive numbering leaves013/014 reserved for independent PR186. Existing evidence/source records and files are untouched.

Kernel reads original version metadata, not a changed library display title or caller-supplied label. Identical replay inserts nothing new. Changed source versions preserve old snapshots; a changed canonical term may produce another source-bound metadata revision. `documentMetadataTags` returns only owner-visible, current-version observations of the latest logical source (owner/origin/origin-key), and intentionally does not elect a winner among metadata revisions. Corrections/manual taxonomy management and exclusive route decisions are not implemented yet; archived snapshots are not a current-truth projection.

## Following slices, not delivered yet

1. Add controlled term/alias administration and reasoned manual/model assignment revisions, with page/chunk-specific scope and evidence. Document-scope inheritance is explicit; a local topic cannot spread to other pages. Classification uses adapters/rules first, bounded AI only for ambiguity.
2. Add automatic routing using explicit canonical choices and soft category/topic hints. A wrong/missing tag must not silently remove the sole correct evidence. Keep cross-source and cross-course synthesis and owner/version boundaries. The shared explicit-scope foundation below is implemented; automatic classification/routing is not yet implemented.
3. Query canonical Kernel facts for deterministic tasks/deadlines/events, original document evidence for content, and both for mixed questions. Integrate via the real website HTTP path, retaining an off/unrouted comparison.
4. Measure eligible/routed/scored files/pages, recall losses and fallback recovery, p50/p95 latency, calls/cost and final answer/citation/refusal metrics on identical corpora/configuration. Candidate shrinkage alone is not acceptance. Keep95/90/95/98 targets, false refusal≤5%, invalid identity/access/version blockers and three frozen independent real-API groups.

No all-library backfill, production deployment, UI change or whole-corpus reparse is included. Tagging does not resolve known table entity/metric/value misbinding. Focused unit and PostgreSQL tests verify this slice's metadata/transaction boundaries, not content correctness or routing efficiency.

## Shared explicit-scope foundation

Kernel search and answer options accept an optional `routingScope` containing `courseIds`, `documentIds`, `origins` and `termIds` arrays. The same optional contract is exposed by the two existing study-send HTTP APIs; no UI option was added. It represents explicit caller choices, not an AI-classification result. Course/term values are canonical IDs; origins are exact stored origin keys. Source aliases must be resolved by the caller before constructing a hard scope. Omitted fields preserve the existing corpus; values within a field are a union and different fields intersect. An empty array deliberately selects no documents. Existing scalar course/document constraints additionally intersect; none is silently overridden.

`document-routing-scope.ts` validates and snapshots this closed contract and supplies one parameterized predicate to keyword retrieval, dense retrieval, coverage/queue selection, exact-title resolution, two-hop references and native-table image supplements. Parents and neighboring pages keep their original selected document identities; returned results and answer context recheck explicit scope before use. A course-term change that invalidates the scope is rejected. Fallback retains the same restrictions. Default/legacy requests without `routingScope` add no scope recheck query or classification-model call.

`KernelService.documentRoutingCounts` reports permission-visible/current files and pages before and after these constraints, separately from actual ranking/scoring. It does not run automatically or certify relevance. Counters cannot establish a speedup, candidate-quality improvement or correct answer. All original owner/source/version guards remain.

Soft-only filename/topic predictions are not accepted by this hard-scope schema. The website records explicit-scope witnesses and candidate counts, separately from semantic correctness. Automatic semantic tag-based prioritization and real corpus performance/answer acceptance remain follow-up work. Do not pass model-produced course guesses into this explicit-choice contract.

## Opt-in literal course-code route

`STUDY_COURSE_ROUTING=explicit-codes-v1` uses the existing canonical Kernel course catalog and a bounded, versioned observation of literal course codes in the current question. Default `off` retains the previous implementation. It supports explicit full/base codes, multiple courses and all matching terms; it never elects the first match or assumes the latest term. Recorded raw observations have original UTF16 positions and a catalog SHA. This is not semantic topic classification or a general natural-language interpreter.

Unknown codes, code exclusions and names-only ambiguity cannot select one guessed course. Explicit all/other-course requests retain broad retrieval. Successful multi-course context may be re-resolved for referential follow-ups; the old IDs are not trusted or written as one thread course. A current explicit caller course/document choice and the existing selected thread course take precedence. Explicit request identity remains separate from the derived route witness.

Before automatically applying a code-derived scope, Kernel checks for a current owner-visible document outside the enabled canonical course catalog using a bounded existence query; it does not load page bodies, vectors or all-page counters. Any missing, disabled or unmapped association keeps broad retrieval with `unassigned-or-unmapped-source`; more than256 catalog IDs similarly keeps broad retrieval. Caller source/term restrictions remain. Filename/topic labels never participate in this exclusion decision. This conservative guard preserves unassigned uploads at the cost of giving up candidate reduction in mixed-quality libraries; it does not certify that every source's canonical association is correct or resolve contradictory natural-language intent.

The successful reply/user metadata records the course decision and whether it was applied or broadened. Tags and history remain query context, not answer evidence. This slice has no model classification, bulk backfill, production toggle or new network service. Independent HTTP content/recall/performance acceptance is still required.
