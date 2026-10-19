# Unified content tags and retrieval routing — Issue193

## First slice: metadata observations, default off

The existing `KernelService.ingestParsedDocument` is shared by indexed Canvas resources/announcements, Piazza text, imported mail bodies/attachments, PDFs and recording transcripts. Opt-in `KERNEL_CONTENT_TAGS=metadata-v1` classifies its stored source metadata in the same PostgreSQL transaction as evidence and the current document-version pointer. Default `off` preserves ingestion behavior; invalid modes fail before source writes. No model call, parse request, embedding or search change occurs.

`content-tags.ts` defines `academic-content-tags-v1` and `source-metadata-rules-v1`. Facets are course, term, source, format, document_type, topic, chapter and assignment. Stable tag identities include taxonomy/facet/key. Source aliases and document-type rules are controlled code under that producer version; changing them requires a new version. Course and term keys reuse PostgreSQL IDs.

An assignment records exact metadata witnesses, method, confidence, document scope and routing use. `identity-only` describes an observed field; it does **not** authorize a hard relevance filter. Confidence1 means exact metadata observation, not that the course association or content is semantically verified. Filename/type predictions are always `soft-only` and can coexist. Semantic facets not implemented in this slice remain explicitly unknown. Tags do not become facts, dates, answer evidence or citation IDs.

Migration015 adds immutable-by-writer `document_tag_sets` snapshots with source/document/version/owner/hash binding, metadata and classification digests, unknown facets and a GIN tag index. Composite foreign keys prevent cross-owner/source/version combinations. This additive numbering leaves013/014 reserved for independent PR186. Existing evidence/source records and files are untouched.

Kernel reads original version metadata, not a changed library display title or caller-supplied label. Identical replay inserts nothing new. Changed source versions preserve old snapshots; a changed canonical term may produce another source-bound metadata revision. `documentMetadataTags` returns only owner-visible, current-version observations of the latest logical source (owner/origin/origin-key), and intentionally does not elect a winner among metadata revisions. Corrections/manual taxonomy management and exclusive route decisions are not implemented yet; archived snapshots are not a current-truth projection.

## Following slices, not delivered yet

1. Add controlled term/alias administration and reasoned manual/model assignment revisions, with page/chunk-specific scope and evidence. Document-scope inheritance is explicit; a local topic cannot spread to other pages. Classification uses adapters/rules first, bounded AI only for ambiguity.
2. Resolve explicit canonical user scope once and apply it consistently to lexical and vector retrieval. Inferred categories/topics are ranking hints or bounded, recoverable branches. A wrong/missing tag must not silently remove the sole correct evidence. Keep cross-source and cross-course synthesis and owner/version boundaries.
3. Query canonical Kernel facts for deterministic tasks/deadlines/events, original document evidence for content, and both for mixed questions. Integrate via the real website HTTP path, retaining an off/unrouted comparison.
4. Measure eligible/routed/scored files/pages, recall losses and fallback recovery, p50/p95 latency, calls/cost and final answer/citation/refusal metrics on identical corpora/configuration. Candidate shrinkage alone is not acceptance. Keep95/90/95/98 targets, false refusal≤5%, invalid identity/access/version blockers and three frozen independent real-API groups.

No all-library backfill, production deployment, UI change or whole-corpus reparse is included. Tagging does not resolve known table entity/metric/value misbinding. Focused unit and PostgreSQL tests verify this slice's metadata/transaction boundaries, not content correctness or routing efficiency.
