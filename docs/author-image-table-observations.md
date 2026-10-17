# Completed author-image table observations (Issue 185)

This is a bounded registration and retrieval slice, with no recognition request,
new evidence node, automatic import, or replacement of original text/images.

## Entry and current-source binding

`kernel.registerAuthorImageTableCandidate(owner, source, run)` accepts one
completed `visible_table_grid_v1` execution. `run` contains the exact request,
provider raw response, candidate, TSV, schema, attempt, HTTP receipt,
request-identity receipt, terminal bytes and the historical complete-source
manifest, plus caption/attachment IDs.
The current Kernel outline and unique caption attachment must match the archived
source/version/structure, PNG and original reference. Request image/TSV/schema,
raw HTTP hash, completed mini model, parsed candidate, usage and the one reserved
then settled execution identity are checked. Receipts are provenance records,
not a cryptographic provider signature or a semantic correctness certificate.

The artifact separately stores `historicalRunSource` from the old execution and
`source` from the fresh Kernel reader. Only `courseId`, a mutable retrieval
affiliation, may differ between those records. Document ID, current version,
source version and source hash must match exactly, as must the caption,
attachment, original PNG, structure manifest and original reference. No old
request, raw response or receipt is rewritten. Candidate IDs, row checks and
all subsequent readers still strictly bind the fresh current course; this
does not authorize cross-course/current-source pooling or version rebinding.

The old receipt's `sourceManifestSha256` identifies a
`CompleteDocumentSourceManifest`, not the structure digest nested inside it.
Registration verifies that manifest's own canonical self hash, original
historical source (including its old course), exact target caption/attachment/
PNG/byte length/dimensions and its nested structure hash against the fresh
outline. The artifact separately stores `historicalSourceManifestSha256`,
`historicalSourceManifestBlobSha256` and fresh `structureManifestSha256`.
The supplied manifest bytes may be a canonical export from an existing saved
object; that export CAS byte hash is not presented as an old standalone file.
No manifest kind is substituted for another or verified merely by its name.

IO and CAS archival precede publication. The short transaction locks the source
and rechecks the current structure/caption/attachment. Migration 013 extends
the existing candidates table: `source_kind=author-caption-image` is distinct
from `pdf-page`, as is producer `visible-table-grid-v1` from Docling native.
Physical page, PDF manifest, PDF options and bbox are unknown/null. They are
never synthesized from the caption ordinal or the grid's row/column numbers.

All ten input/receipt blobs remain explicit, bounded historical GC
references after a source becomes hidden or changes. The AST can be rebuilt
from the saved raw output using the saved protocol/helper; re-registration
requires the original source still to be current. It does not transplant an
old execution onto a different current version with the same-looking PNG.

## Retrieval and answer transport

Author candidates use the existing FTS table with the legacy helper's complete
cell locator/role/span/text search serialization. They are queried only for an
explicit source hint or the existing uniquely resolved full-title mention in
`answerStudyContent`. The original retrieval question and global ranked anchors
are retained. No hit means no forced table/image selection. Image-disabled
requests and the existing derived-table-disabled supplemental queries never
enter this lane. The source/row/current version and unique
attachment are verified again on both sides of the actual PNG read.

The resulting `image.tableObservations` contains an
`author-image-table-observation-v1` envelope. Both selector and generator see
the legacy typed AST beside the original PNG. Only the PNG's existing image ID
is selectable; supplemental captions bind that PNG but are not fabricated
quotation units. The selected-only local audit continues to receive only its
existing selected caption members and original PNG, never the AST.

Native and author producers share the two supplemental-image slots and the
existing total image budget. Each image has at most two observation envelopes;
the existing 32 KiB UTF-8 complete-envelope limit applies to each producer.
An oversized AST is omitted as a whole with `unavailable/observation-byte-limit`
and its bound identity/byte length retained. It is not truncated or silently
called complete. Actual answer-builder budgets count transported metadata.

This slice does not add author candidates to every planned/complete-source
reader or a global cross-source table-ranking union. Existing native public
APIs, default no-observation fields, prompts and local-audit semantics remain.

## Legacy protocol and limitations

`visible-table-grid-v1.mjs` preserves the historical helper's original semantics
and local source bytes (archived helper SHA
`1988b58e305fe632b78df879ddb8e2691f936e65874992b73a93176b984e7950`).
`helperSha256` identifies that archived source, not a claim that Git's normalized
Linux checkout has identical line-ending bytes. The executing version must be
bound separately by its actual Git head/code-file hashes, as in the existing
isolated controller. No historical protocol is relabeled as a newer producer.
The canonical schema identity is SHA of `JSON.stringify(schema)`
`fd011827457cc74b5346113edf4b6101a0ca12f2e3e8cf9d57c472278837a1c5`;
the original schema byte hash is separately stored in `rawSchemaSha256` and
the schema CAS reference. The original completed schema file is
`36fd39acec61d8d733ee901a9135446d6c644b603c3cb1bc9f9c08c8f516fcb4`.

`section` and spans retain their original v1 declarations. No universal parent
header tree is inferred, and the newer PR184 semantics are not used to
reinterpret this artifact. The helper's historical HTML is not product input
or a rendering guarantee. Its known browser-default header boldness issue is
not repaired by relabeling the old result. Coordinates, visibility, section
hierarchy, semantic relationships and factual correctness stay unverified.

The saved C23 table independently established values/row labels/header spans
for that exposed image; its legacy HTML full-fidelity failure and the original
C23 answer failure remain separate historical results. Registration, FTS,
schema validity and successful transport do not establish answer accuracy.

## Verification scope

New local component checks cover the preserved legacy AST, actual selector/
generation metadata, PNG-only local audit, altered/foreign provenance rejection,
complete-envelope refusal and unchanged no-observation input. One normal CI
PostgreSQL integration target registers a synthetic run on a real current
caption/attachment, exercises natural full-title lookup through the real
application selector/generator builders using mock responses, and rejects
foreign/current/row bindings. Its 1px synthetic image and responses test
plumbing, not recognition or source fidelity. Local execution does not run PG,
models, migrations, historical suites, or deployment.
