# Explicit current-page Docling observations (Issue 187)

`KernelService.readDocumentPageRegions(owner, currentSource, physicalPage)` is a
separate read-only path. It does not alter ranked search, complete-source
readers, stored page bodies, quotation IDs, ingestion, or default model inputs.
It never parses a PDF, renders, OCRs, writes to PG/CAS, migrates, or calls AI.

## What is returned

An available result binds the actual current owner/document/version/source,
page evidence and body hash, immutable PDF visual manifest, checked original
page PNG identity/frame, saved Docling result/input/copy-map/settings identity,
and an index of declared nodes. Image bytes are checked but not duplicated in
the return value; use the existing visual reader if bytes are needed.

Nodes keep actual raw text/orig, label, formatting, parent/children and other
declared reference arrays, prov and native table data. Paths and ordinals are
first traversal positions in the producer's declared graph, not certified PDF
reading order. Shared references retain their original links, not extra invented
nodes. Ancestor containers are explicitly `ancestor-reference`, not asserted to
have page geometry. Multi-page node text is not sliced into guessed page text.
`declaredPageNumbers` are the producer's local pages; `physicalPageNumbers` are
mapped strictly through the saved copy indices. Ancestor-only containers do not
acquire an invented physical-page declaration.

Geometry is `observed` only for one supported bounded box on that page; missing,
unsupported or ambiguous geometry is `unknown` with raw prov retained. A
matching unrotated zero-origin frame exposes continuous affine maps for both
TOPLEFT and BOTTOMLEFT origins (the latter includes the actual y flip/offset).
All other frame relationships remain unknown. Raw boxes are never normalized,
cropped, or used to infer visual relationships.

`sourceBindingVerified` in the index means the raw CAS wrapper matches the
expected original-source/input/copy map; the reader separately checks the
current relational source and PNG binding. It does **not** verify extracted text,
visibility, reading order, table semantics, formula scope or arrows. Those flags
remain false, inferred relations remain empty, and source content is untrusted.
Unknown historical options/version fields remain null. An empty index is not
proof of a visually blank or completely transcribed page.

## Bounds and failures

- One explicit page, original source at most 500 pages.
- Saved result: `open`/`stat` before allocation; at most 16 MiB, bounded read
  plus one byte to detect growth; actual byte count and SHA checked before JSON.
- At most 10,000 visited nodes, 20,000 edges, depth 128, and 1 MiB serialized
  page-index output. No truncation or partial `available` result.
- Only current registered batch provenance / PDF layout references are followed.
  A caller cannot choose a raw hash. Owner/source/input/options/copy map/range
  must agree with the actual saved wrapper; conflicting result coverage is
  unavailable. Current source and parsing provenance are rechecked at the end.
- No Docling, missing raw/PNG, unsupported source size or ambiguous result:
  explicit unavailable. No parser/model fallback. Invalid bindings/checksums or
  stale current source reject. Missing node page provenance makes the result
  unavailable; missing optional bbox alone preserves the node as unknown.

## Validation scope and reusable fixture

`tests/source-page-regions.test.ts` exercises the actual exported context reader
with a **synthetic registered Queryable adapter**, not real PostgreSQL. The
small factory `tests/fixtures/source-page-regions.ts` accepts optional
`{sourceHash,inputHash,pageEvidenceId}` overrides for controlled real-PG
registration; default component inputs remain unchanged. One new test in the
existing `kernel-integration.test.ts` creates an actual 100×200 synthetic PDF,
uses the existing visual staging with an injected 1px PNG renderer, registers
through `ingestParsedDocument`, and calls the real Kernel reader. It checks
available/source/image/body bindings and rejects a wrong owner. It has **not**
been run locally; the existing PostgreSQL CI entry will run it. Synthetic
Docling declarations and injected PNGs are not PDF-fidelity acceptance.

The local existing-Lec4 check reads the already saved layout-only JSON and
frozen manifest/geometry report. It verifies 27 declared nodes, unchanged page
serialization, and the BOTTOMLEFT-to-PNG affine against the stored frame. It is
not registered as a current Kernel source, does not reparse a PDF, and does not
assert new visual fidelity or blind-test success. Its receipt is in ignored
`data/issue187-validation/existing-raw-check.json`. Existing raw and scores stay
unchanged. C23's wrong table/citation role cannot be cured by treating OCR or
this index as semantic evidence.

## Optional study-request projection

Current retained original PDF pages can carry source-bound observations through
the application study request. The optional complete observation limit is 32 KiB
per page / 64 KiB per context. The existing 300000 total request bound still wins;
original text, quote IDs and PNGs keep priority. Oversize observations remain
explicitly unavailable; no prefix is represented as complete. Full source
fingerprints remain distinct from actual transmitted-request digests.

Within the unchanged 64 KiB context bound, whole observations use original-image
order first-fit with complete unavailable wrappers reserved; later smaller items
can still fit, existing unavailable reasons stay intact, and only a wrapper that
itself cannot fit is omitted with `metadataOmissionReason` in the read receipt—
never by truncating observations, clearing every page, or changing text/PNG/IDs.

The former 16 KiB page limit omitted a real 19799-byte PDF19 observation despite
valid source/PNG bindings. This capacity correction preserves that earlier
unavailable result and all historical semantic failures; no new parse, rendering
or source rewrite is involved. The observation's semantic/visibility/order
verification flags remain false. This transport check is not website HTTP or
content-fidelity acceptance.
