# Registered Docling orig recall hints (Issue 187)

## Hypothesis and scope

PDF11 physical page 15 has two registered raw `orig` strings absent from its
current stored body. Body-only lexical/vector indexing cannot recall those
terms before page-regions enrichment. This change tests a narrower hypothesis:
registered, unverified `orig` can help retrieve the **same original page**.
It does not repair transcription, answer correctness, visibility, or reading
order. No PDF parsing, OCR, embedding, model, new service, or extra evidence
node is introduced. Frozen results and original files remain unchanged.

`prepareDoclingOrigSearchHints` follows the current registered result mapping,
checks actual CAS bytes and saved owner/source/input/options/copy map, and uses
the existing page-region decoder. Only declared, single-page `orig` strings
are eligible. Ancestors and ambiguous multi-page text are not reassigned to
one page. Missing provenance can make the existing decoder unavailable; it
does not license guessed attribution. Geometry and semantic relations remain
unknown/unverified. The original producer schema/version is recorded, nullable.

Limits are 256 eligible items, 32 KiB UTF-8 orig text, 64 KiB prepared proof,
plus the existing raw/result/page limits. An exceeded limit fails the whole
preparation; no prefix is published. Refresh/rebuild fail before any index
update on missing/corrupt/foreign/mismatched raw. Normal ingest alone treats
an expected `unavailable`/`limit` as optional metadata unavailable and may
publish its otherwise valid body. It returns the page/reason/code in an
`origSearchHints` receipt, outside immutable parser warnings/version identity.
Invalid source/input/checksum bindings remain fatal. No-data ingestion still
has its old void result, and existing same-version hints are not cleared.

## Publication and replay

- Normal PDF ingestion stages raw outside the transaction and verifies the
  **persisted** source version's progress before publishing the derived index.
- `kernel.refreshDocumentOrigSearchHints(owner, currentSource, physicalPage)`
  addresses one exact current source/page. It rechecks owner, visibility,
  current/source version, source SHA, parser, body, progress, previous index
  and provenance in a short transaction. A repeated result is `unchanged`.
- `rebuildDocumentSearch` prepares every requested current page before opening
  the publication transaction. Only after a matching locked snapshot does it
  replace derived chunks/search/provenance. A preparation/CAS failure leaves
  old chunks, search and provenance intact. There is no raw IO in that
  transaction and no embedding call.

The base is always `documentSearchText(original body)`; hints whose exact orig
already occurs in the body are not appended. Rebuild reopens registered raw,
not an old appended search snapshot. Controlled old provenance must reproduce
the old index exactly. Unknown pre-existing page search additions cause a
refusal instead of being lost or compounded. The known migration-004 plain
body base is accepted and normalized. Native table `cellTexts` stay in their
existing independent candidate index and are not erased or reconstructed here.

Migration 014 adds nullable `document_text_pages.search_hint_provenance`.
It binds source/head/evidence/page/parser/body SHA, raw/input/options/copy map,
registered progress SHA, producer, exact orig/ref entries, normalized base and
final index SHA. Original body, snippets/quotes, evidence, confidence, warnings,
PNG/manifest, facts and vectors are unchanged. No source version is created by
refresh/rebuild. No-hint search hits gain no empty/undefined metadata key.

Keyword hits expose `retrieval_hint` with provenance/hash/raw/ref pointers and
fixed `unverified-retrieval-hint` authority, never as body or a new quotation.
Full-page reading preserves that metadata and still verifies original source
identity. Local citation checks continue to use actual text/PNG evidence;
matching a raw hint is not factual support.

## Verification boundary

Two new pure targets exercise actual synthetic CAS staging, provenance/body
and index guards, independent replay/idempotence, bounded failure and no-data
compatibility. The one additional PostgreSQL integration target registers a
synthetic PDF/raw with an injected 1px PNG (explicitly **not** recognition),
checks automatic ingestion, simulates a legacy body-only index on that fixture,
then checks natural FTS recall, exact page/body/evidence/PNG preservation,
refresh/rebuild/replay, wrong-owner/stale-source refusal, corrupt-raw atomic
failure and normal body ingestion with missing optional raw. The PG target is
reserved for normal CI; it is not executed locally.
No old cohort is rerun and no historical score changes.

This target proves lexical FTS recall and a real Kernel read of the same stored
page only. Dense/vector recall is unchanged. Optional AI reranking can still
ignore a hint-only match when it sees the original body; end-to-end rerank and
answer quality remain unassessed. No retention floor or new ranking policy is
added here.
