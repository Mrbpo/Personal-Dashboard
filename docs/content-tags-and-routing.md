# Unified content tags and retrieval routing — Issue193

## First slice: metadata observations, default off

The existing `KernelService.ingestParsedDocument` is shared by indexed Canvas resources/announcements, Piazza text, imported mail bodies/attachments, PDFs and recording transcripts. Opt-in `KERNEL_CONTENT_TAGS=metadata-v1` classifies its stored source metadata in the same PostgreSQL transaction as evidence and the current document-version pointer. Default `off` preserves ingestion behavior; invalid modes fail before source writes. No model call, parse request, embedding or search change occurs.

`content-tags.ts` defines `academic-content-tags-v1` and `source-metadata-rules-v1`. Facets are course, term, source, format, document_type, topic, chapter and assignment. Stable tag identities include taxonomy/facet/key. Source aliases and document-type rules are controlled code under that producer version; changing them requires a new version. Course and term keys reuse PostgreSQL IDs.

An assignment records exact metadata witnesses, method, confidence, document scope and routing use. `identity-only` describes an observed field; it does **not** authorize a hard relevance filter. Confidence1 means exact metadata observation, not that the course association or content is semantically verified. Filename/type predictions are always `soft-only` and can coexist. Semantic facets not implemented in this slice remain explicitly unknown. Tags do not become facts, dates, answer evidence or citation IDs.

Migration015 adds immutable-by-writer `document_tag_sets` snapshots with source/document/version/owner/hash binding, metadata and classification digests, unknown facets and a GIN tag index. Composite foreign keys prevent cross-owner/source/version combinations. This additive numbering leaves013/014 reserved for independent PR186. Existing evidence/source records and files are untouched.

Kernel reads original version metadata, not a changed library display title or caller-supplied label. Identical replay inserts nothing new. Changed source versions preserve old snapshots; a changed canonical term may produce another source-bound metadata revision. `documentMetadataTags` returns only owner-visible, current-version observations of the latest logical source (owner/origin/origin-key), and intentionally does not elect a winner among metadata revisions. Corrections/manual taxonomy management and exclusive route decisions are not implemented yet; archived snapshots are not a current-truth projection.

## Source-bound classification revisions (Issue193, migration016)

`KernelService.recordDocumentClassification` stores an explicit proposal/correction in
one short PostgreSQL transaction. Existing ingestion and retrieval defaults are
unchanged. It does not run AI, infer new tags, backfill the library, or authorize a
filter. `documentClassifications` returns current heads of independent classifiers;
it never silently chooses a winner between a model and a human.

Each request contains `documentId`, `versionId`, `sourceVersionId`, `sourceHash`,
`classifierId`, `producerVersion`, `method` (`manual`, `rule`, `model`), `model`
(a name for model proposals, otherwise null), `previousId` (null initially), and
`tags`. Tags contain `facet`, `key`, `confidence` and one `evidence` witness:

- `page`: physical `pageNumber`, current `evidenceId`, `startUtf16`, `endUtf16`,
  and exact `text`. Kernel verifies the source substring, Unicode boundaries and
  stores UTF8 SHA256 of the original page body/fragment. This always produces a
  fragment-scoped label; it is not expanded to the document.
- `source-metadata`: an exact `field`/`value` observation of name, mime, origin,
  originKey, courseId or termId. Kernel reads original source metadata rather than
  trusting the request's value. Its scope is the document.
- `human-judgment`: manual proposals only, attributed to the required actor and
  correction reason. This does not fabricate a source excerpt or verified fact.

Multiple facets/labels coexist. Ordinary keys share NFKC/lowercase/whitespace
normalization; canonical course, term and task IDs retain case and must exist.
Unknown facets remain explicit; confidence is not semantic verification. Every
assignment is `soft-only`, with false semantic/filter authority. Controlled topic
vocabulary/aliases and automatic extraction are still follow-up work; normalized
free keys are not a complete semantic ontology.

Records retain source/version/hash, producer and model version, actor/reason and
parent revision. `previousId` is a compare-and-set token: a stale correction fails
instead of overwriting another edit. An identical replay can return an older
revision but never resets the active head. Empty tags explicitly withdraw that
classifier's proposals. New document versions require fresh classification;
history remains, but stale, hidden, superseded and foreign-owner records cannot
serve as current labels. No canonical course/task/fact, original body or evidence
is rewritten. No labels are yet consumed by preselection.

Administrator CLI (same application module, no network service):

```text
node --experimental-strip-types scripts/kernel-classify.ts list <owner> <document-id>
node --experimental-strip-types scripts/kernel-classify.ts record <owner> <input.json> "correction reason"
```

The write command requires a named administrator account. Source identities in the
JSON must come from current Kernel metadata/readers; guessed IDs or stale versions
are rejected. This endpoint is not exposed as a public unauthenticated API.

## Remaining classification and routing work

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

## Classification preselection comparison, not an active final filter

`KERNEL_CONTENT_TAG_ROUTING=classification-shadow-v1` proposes a document scope
before lexical scoring using current classification revisions. It reuses the
controlled source/type query aliases and literal topic/chapter keys. This does not
provide general topic synonym resolution, exclusion interpretation or semantic
classification. It reads bounded classification metadata and existing explicit
scope predicates; it does not load every document body/vector to classify them.
Stored revision/input/assignment digests and fragment scopes are validated before
use. Old, hidden, superseded and foreign sources cannot propose current candidates.

Only explicitly lexical (`semantic=false`, `hybrid=false`, `aiRerank=false`)
non-strict requests without a resolved document/source hint enter the comparison.
The existing baseline and the proposed branch both run, under the same owner,
course/source/term restrictions. Recursive calls do not replan. Capacity overflow,
invalid revisions or no literal labels retain broad search. Branch errors do not
replace the successful baseline. Indexed fragments select candidate files for this
experiment; their classifications remain fragment-scoped, unverified observations.

**Only the baseline is returned. This mode saves no total request work and is not
a production prefilter.** Wrong and absent tags can lose evidence even when the
branch returns plausible results. Per-hit `classification_route_shadow` records
the proposed source/revision IDs, reason, whether the branch ran, returned counts
and the number of baseline evidence tuples absent from the branch. These are not
Gold recall or numbers of files scored (`scoredDocuments=null`). If no branch ran,
its counts/loss are null. Kernel forwards only optional diagnostics to the existing
reply metadata as `study.classificationRouting`; tag labels never become answer
evidence, canonical state, or source citations.

Default off and the existing metadata-priority behavior are unchanged. Enabling
this test mode needs migration016 in that isolated database; no existing server
corpus or production migration is implied. Controlled topic vocabulary, automatic
classification, recovery policy and final branch adoption remain open and need
real corpus/HTTP recall, answer, citation and refusal validation.

## Existing metadata candidate priority

`KERNEL_CONTENT_TAG_ROUTING=metadata-priority-v1` consumes current `source-metadata-rules-v1` tag snapshots in shared Kernel retrieval. Default `off` preserves the old ordering and makes no tag query. Controlled English/Chinese aliases map literal mentions of document types and sources to existing taxonomy keys; they do not classify arbitrary topics or interpret source exclusions as permission to filter. Queries without aliases and strict lexical search retain their existing path.

The route reads metadata for the already bounded pool: lexical results, semantic results, or the existing AI selector candidate pool. It does not read original bodies or vectors, increase candidate capacity, parse documents, produce embeddings, invoke a classifier or change explicit course/document/source/term constraints. Every requested page is checked against the current owned, visible logical source and its version/hash/evidence identity. Missing or changed identities reject, rather than routing with stale tags.

Snapshots must use the supported taxonomy/producer and reproduce their stored classification digest and tags from original metadata. Multiple current metadata revisions must agree on each matching tag; the route does not choose one revision as truth. Missing, invalid or contradictory tags receive no priority and remain eligible evidence. Old-version, superseded, hidden and foreign-owner snapshots cannot supply hints.

Within each original eight-candidate rank window, matching candidates precede nonmatching candidates with stable order. Maximum movement is seven positions, every original candidate remains in the same pool, and original relevance scores and evidence are unchanged. Per-hit `content_tag_routing` records the plan digest, original/final rank, pool count/set digest, matches, snapshot identities and fallback reason. It explicitly denies filter authority and semantic verification. Tags are not supplied as quote evidence. AI still selects from the whole same pool; other search modes retain their existing final top-k behavior.

This is a limited category/source priority step, not full semantic classification, a hard prefilter or proof of fewer files scored. Metadata lookup adds work; file/page scoring counts and model-input capacity are unchanged. Wrong tags can still affect ordering or final top-k relevance, and missing tags cannot help documents outside the original candidate pool. Same-corpus recall, answer/citation correctness and performance require real HTTP comparisons before adoption. No production toggle, library backfill or new content score is implied. Topic/chapter/assignment inference, correction administration and adaptive scoped routing remain open.

Kernel captures the ranked reader's returned anchors after its normal source recheck. The two existing HTTP send paths persist this diagnostic as `answer.meta.study.contentTagRouting` when routed anchors exist. The observation identifies source/page/evidence bindings and the original candidate-pool receipts; `scope=ranked-reader-returned-anchors-only` explicitly distinguishes the returned anchor subset from the whole pool and corpus. Pool size is not the number of files scored, and `eligibleCorpusDocuments`/`scoredDocuments` remain null. Expansion sources and neighbors without a routing receipt are not retroactively assigned one. Nothing is added to generation inputs, citations or canonical facts. No routed anchors means the optional field is absent, retaining the old response shape.
