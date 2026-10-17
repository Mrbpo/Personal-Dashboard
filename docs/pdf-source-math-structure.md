# Source-bound Docling mathematical structure — Issue #163

This first step preserves existing extraction roles and serializes only explicit
roles. It adds no recognition model, PDF parser, UI, table, service or canonical
business fact. Original raw results and old document versions remain immutable.

## Actual data path

`decodeDoclingResult` retains bounded mathematical/inline nodes with their real
reference, traversal path, declared parent/children, orig/text, formatting and
unchanged raw provenance. Explicit InlineGroup children stay in their original
order with their actual spaces. A formula in such a group is inline; a formula
outside retains the existing block behavior. Explicit `sub`/`super` text roles
are escaped and represented by `<sub>`/`<sup>` at that position. These roles can
also be prose footnotes or chemical notation: the serializer does not invent a
math base or force prose into a TeX environment. Scripts without an explicit
inline group retain their original string/position and an uncertainty warning.

The existing character-preservation check still rejects changed/unsupported
enhanced formulae and uses the full orig. Neither raw `n2` nor a missing role is
guessed into an exponent. Legacy unanchored `formulae:string[]` enrichment is
unchanged and is not upgraded into a source-bound structure. Ambiguous own text
plus inline children, shared/cyclic inline occurrences and spanning inline leaf
page boundaries fail clearly rather than silently dropping/duplicating text.

The real batch decoder maps derived pages through `copyIndices`; raw prov keeps
its original derived page numbers. Each structure then carries the actual saved
result SHA, input SHA, page map and enrichment mode. Full-result and cached raw
paths carry the same data. `prepareDoclingSourceMath` checks the saved CAS bytes,
owner/document/original source hash, input hash and page mapping, and re-decodes
that JSON to compare the complete structure. It does not reparse the PDF or
request any remote fallback. The prepared immutable receipt also binds each
final page body hash. Digest-shaped caller fields alone are insufficient.

`KernelService.ingestParsedDocument` consumes this prepared receipt in its
existing short transaction:

- The structure hash participates in the immutable version identity.
- Existing source parsing provenance declares raw CAS references for retention.
- Page evidence records the structure identity and unverified relation status.
- Existing `document_structures` stores the source-bound mathematical metadata
  alongside the real page nodes. No new storage schema is introduced.
- Existing structured source/outline readers expose the matching page's math
  metadata and still reject a changed body/source/manifest. Direct public
  structure registration cannot invent this field without verified staging.

Math-aware parser output gains a `-source-math-v1` identity suffix. Cached replay
also notices missing/different math structure when text is unchanged, so the old
raw can supply a new derived version without a new conversion. A matching
subsequent replay remains unchanged. Raw nodes and their serialized structures
are bounded (10,000 nodes per result and 8 MiB per complete document); exceeding
the bounds fails explicitly. Existing global query/image/request limits remain.

## Verification performed

The initial four focused checks in `tests/docling-source-math.test.ts` passed:
**4 pass, 0 fail, 0 skip**. Root review then identified an orig-only inline
fallback gap. After fixing it through the existing content fallback, only the
new body/rich-cell regression was run: **1 pass, 0 fail, 0 skip**. The prior four
checks and the saved-raw page were not rerun for that fix.
The new script representation then received a narrow search-copy normalization:
only exact paired `<sub>`/`<sup>` tags are removed, followed by a single decode
of their fixed escaped entities. Encoded literal tags are not stripped again;
general HTML/attributes and plain original entities are not interpreted. Only
its additional normalization regression was run: **1 pass, 0 fail, 0 skip**.
The prior four checks and the orig-only regression were not repeated.
These cover inline/body/rich-cell serialization, explicit scripts and source
spaces; refused enhancement and ambiguous/missing roles; real cached batch
decoding and original page mapping; raw/owner/body/forged receipt rejection;
CAS retention; and the actual Kernel ingestion→structure→current reader path.
The SQL boundary is mocked in memory. No PostgreSQL connection or write was
performed, and this is not a PostgreSQL integration acceptance result.

Type checking passed before those two narrow string-normalization fixes. One existing Bellman JSON result was read through the
new decoder; its page body and warnings exactly match the already reviewed
projection (body SHA `bbe42d07ea50c60b8b99a7ed708be9ea48885f9c78584e2a88122393f1f64174`).
It contains no InlineGroup, so no source script role was recovered or invented.
The original result bytes were unchanged. The local receipt is in the ignored
`data/issue163-validation/` folder. No original PDF, C50 code/Gold, recognition
response, benchmark score or production setting was changed.

## What remains unverified

All exposed structures retain `sourceProven:false` and
`formulaRelationsVerified:false`. Docling roles can themselves be wrong.
This step does not recover missing glyphs, bases, fractions, limits, matrix
geometry, arrow relations, chemical connectivity or author reading order absent
from the raw. It does not apply the staged style tool or certify whole pages.
Future region recognition and source comparison remain separate work.

Status: local code and focused checks completed; CI/PR publication, deployment
and production switching have **not** been performed for this change.
