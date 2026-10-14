# Verified source context

These application-internal `KernelService` methods attach source hierarchy and
original images to existing, immutable PostgreSQL document evidence. They do
not change document bodies, search scores, the ranked anchor list, document
heads, or canonical business facts. There is no new UI or network service.

## Adapter registration

Resolve a current source, then call `readDocumentSourcePages(owner, source)` to
obtain its actual evidence IDs, original locators, bodies and body SHA256 values.
`source` contains `documentId`, `currentVersionId`, `sourceVersionId`,
`sourceHash` and an optional `courseId` constraint.

`registerDocumentStructure(owner, source, input)` accepts an adapter's complete
original hierarchy: `rawSourceHash`, `parserVersion`, parent IDs/headings and
every original node in its stored order. Each node binds its evidence ID,
locator, zero-based ordinal, kind, parent ID and body SHA256. The original source
hash must match both the document and its source-item version. Missing nodes,
substituted bodies, cycles and missing parents are rejected. Abstracts and
captions are independent nodes; section headings remain metadata. Registration
is idempotent for the same canonical manifest and immutable for that version.
The adapter is responsible for deriving hierarchy from the actual source; the
Kernel validates its complete association to the stored original evidence, not
the semantic correctness of a heading or a parser's interpretation.

`registerDocumentImage(owner, source, input)` accepts a current caption evidence
ID, the original reference, original bytes and provenance (source URL, revision,
optional archive SHA/member, license and attribution). It does not fetch URLs.
Bounded PNG bytes are retained by SHA256 in the existing `LIBRARY_DIR`; only
attachment metadata is stored in PostgreSQL. A caption is never a replacement
for pixels. Registering conflicting attachments leaves explicit ambiguity.
These assets belong to the existing non-core library backup scope.
Source/caption preflight and blob staging/checks run outside a transaction.
Only afterwards does a short Kernel transaction recheck the current source,
structure and caption and insert metadata. A changed source cannot publish the
attachment; its already retained content-addressed blob remains reusable.

## Reads and accounting

`readDocumentOutline` returns heading metadata, node identities/lengths and
captions without complete paragraph bodies. `readDocumentParents(owner,
anchors, {includeImages?})` accepts at most 14 actual `full-page` search hits,
with exact current version IDs and complete stored bodies. It returns the same
anchors and order, plus separate parent packets. Each available packet contains
all original descendant bodies in source order. Their sum must be at most
**8192 Unicode codepoints**, counted by `Array.from(body).length`; separators and
heading metadata are not added to evidence bodies. Oversize packets have status
`unavailable-size-exceeds-8192`, an empty `nodes` list, and the full node manifest,
count and original size. They are never clipped or reduced to selected nodes.

`readDocumentImages` binds requested caption IDs to the same current source,
reads actual bytes and checks SHA256, length and PNG dimensions. Missing,
conflicting or changed images fail explicitly. With `includeImages: true`,
parent reads return actual attachments for their available caption nodes and
fail if those attachments are missing or ambiguous.

All reads enforce owner, optional course, visibility, current version,
source-item/evidence association and newest visible origin. They recheck source
identity before returning. Source content is always marked untrusted. A stale
anchor, partial body or changed source produces `DOCUMENT_CONTEXT_CHANGED`;
there is no stale-cache or snippet fallback. Returned accounting distinguishes
anchor count, parent count, context-node/codepoint count and image count/bytes.
Expanding context is not an increase in the ranked search result count and is
not by itself proof of answer correctness or document transcription fidelity.

## Scope of verification

`tests/document-context.test.ts` uses isolated PostgreSQL fixtures with external
fetch blocked. It covers actual search-hit preservation, complete manifests,
immutable/cyclic hierarchy rejection, owner/course/hidden/current/newest-origin
guards, the Unicode size boundary, actual image bytes, missing/ambiguous/corrupt
assets, a source hidden during image reads, and source changes between
transaction-free blob staging and metadata commit. CI performs the existing build
and PostgreSQL integration gates. Merge and CI success do not deploy the service
or constitute the three full document/PDF acceptance sets.
