# PDF visual evidence

PDF visuals are source-derived evidence attachments, not canonical facts or verified AI transcriptions. No UI or separate service is introduced.

## Producer

`decodeDoclingResult` retains actual picture provenance, raw bbox/origin, page sizes and picture-child text references. Missing optional geometry preserves valid page text and reports layout unavailable. Derived batches map `localPage` to `copyIndices[localPage-1]+1`; raw result/input hashes and the explicit mapping survive aggregation and cached replay.

`preparePdfVisualEvidence` checks original PDF bytes and saved `{identity,result}` blobs, including owner, document, source, derived input and picture bbox. It renders source pages with the existing local Poppler renderer and crops exact pixel regions with pinned Sharp, without model coordinates, rescaling or answer-based adjustments. Rotated/cropped region geometry without an implemented transform is rejected explicitly. Native/visual paths have no invented regions; they retain page images and mark Docling layout unavailable.

Completed page assets are cached under a source/layout/renderer identity, checksum-verified on resume, and reused after interruption. A renderer failure retains completed assets and original layout metadata, reports visual unavailability and never publishes a partial manifest as complete. Staging is bounded to 500 pages, 1500 assets and 256 MiB. Rendering and blob IO are outside the database transaction.

## Atomic metadata and readers

Migration011 adds one immutable PDF visual-manifest row per document version. Its stable content digest contributes to parsed/source version identity. Kernel ingestion binds each asset to the genuine page evidence in the same transaction that publishes the document head and physical-page structure. Failed attachment publication rolls the entire version/head back. Existing author-caption attachments keep their separate type, validation and one-image-per-caption rule.

`kernel.readPdfVisualEvidence(owner, expectedSource, optionalPageEvidenceIds)` returns real `pdf-page` / `pdf-region` evidence. It verifies owner/current source, page anchors, manifest hashes and PNG bytes/dimensions, then checks the source again. It exposes layout metadata even when rendering is unavailable. Multiple regions can share one page. Reads enforce count, byte and input-token bounds and fail rather than silently truncate. Historical manifests contribute original PDF, raw result, derived input, page-render and region hashes to blob GC's reference set.

Kernel parent/complete-source contexts include these assets through the verified reader. A source with database MIME `application/pdf` cannot be returned as complete when its visual manifest is missing or rendering is incomplete; ordinary text retrieval remains usable. Non-PDF author-caption contexts keep their existing contract. Answer image supports bind the real page evidence, original physical page, raw PDF SHA, PNG SHA and manifest SHA. They never relabel a PDF page as an author caption. Selected-source synthesis rechecks the complete context before returning citations. Existing answer/model limits remain in force; adding page images can produce an honest image/input-limit result on large PDFs.

Cached Docling replay audits visual availability separately from text quality. Missing, changed or incompletely rendered manifests permit a reviewed visual-only publication with the existing current-version guard, original text, parser provenance and warnings. Complete matching manifests are unchanged on repeat. Completed staged pages are reused; drafts belonging to known documents or persistent ingestion jobs also retain their blobs during collection.

## Verification limits

The two public MIT raw Docling fixtures test metadata preservation without another conversion. Offline tests use synthetic page renders to check exact crop pixels and interrupted-page reuse. The PG test checks atomic rollback/replay, ownership/current-source guards, multiple regions and mocked answer citation binding; it is not an OCR/semantic accuracy claim.

Preserving page/region pixels does not certify that prose, numbers, formulae or tables are correctly transcribed. Candidate model text/geometry is not written by this implementation, and no existing fidelity/retrieval score is changed. Existing PDFs need a controlled ingestion/replay to acquire assets; no automatic production backfill or deployment occurs on merge.
