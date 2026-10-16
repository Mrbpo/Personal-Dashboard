# Insertion-only PDF style staging

Issue #138 reuses the reviewed PR136 Poppler native text-run producer without enabling whole-page rewrite, adding its failed prompt, or adding a SQLite envelope. All new selection/staging functions are pure; no model, PDF parser, database, UI or publish path calls them automatically.

`preparePdfStyleSelection` freezes the old checked body SHA, old source/page/PNG identity and actual native sidecar. A different old/producer source requires an explicit declared page map and remains unverified. It finds eligible existing math leaves with a deliberately bounded grammar; unknown commands, unsupported unbraced structures, script fields and existing style groups are skipped. It does not correct the old body or add math delimiters.

Native positive bold/italic spans retain their actual full run boxes. Whitespace-separated single decoded atoms may have offsets into the original style-span text; those offsets never create glyph boxes or font-file proof. Continuous words, combined bold+italic, italic Greek and obvious symbolic/custom font families are conservatively declined. The font-name filter can over-decline legitimate fonts and cannot certify other encodings. All remaining decoding and alignment remains unverified. Repeated atoms retain separate real IDs and require review; model choice is not source proof.

`buildPdfStyleSelection` gives a bounded pair-only schema; output cannot carry text, coordinates, offsets or styles. `validatePdfStyleSelection` accepts only existing compatible IDs, each used once. The server chooses the allowed positive wrapper. `stagePdfStyleSelection` inserts wrappers without deleting or replacing any existing character, and records only the owned insertions. Their inverse must restore the original UTF-8 bytes; non-style token and math-boundary signatures are retained, and arrows/operators/scripts are checked unchanged. `validatePdfStyleStage` reconstructs the exact result and rejects changed text or operation ranges.

The receipt reuses derived staging fields (`rawRecognitionSha256`, `derivedTextSha256`, operations, `requiresManualReview`, `notForApplyPageRepair`) and always declares `sourceProven:false`/`alignmentVerification:unverified`. No glyph geometry or `vectorOrderVerified` is invented. Unsupported/empty selection leaves the old body unchanged. Matching IDs and passing invariants establish content preservation, not correct style placement, mathematical correctness or full-page fidelity. No automatic application is provided.

The pure functions and focused tests perform no model call, PDF parsing, PostgreSQL write or hidden/Gold read. PR136's failed whole-page output is never used as a baseline, and old raw/scores stay untouched.

## v2: bounded prose-anchor eligibility

`pdf-source-style-staging-v2` retains complete native prose runs to derive double-sided anchors (4–8 normalized words, unique in the native run collection and baseline prose outside math). Actual source offsets/whole boxes, source/baseline text, match counts, interval boundaries and policy are included in the frozen plan, request data and stage receipt. Prose token comparison normalizes canonical Unicode/apostrophes and ignores punctuation/spacing; it never rewrites the old body.

Whole-run geometry supplies partial-order hints, not proof of columns or logical reading order; run array index is never used as proof. Missing, overlapping or conflicting anchors decline correspondence. A same-atom math leaf must be unique inside the interval; competing native occurrences decline, and validation rejects cross-interval choices even if both IDs exist. Baseline script fields remain excluded. Native size below 0.8 of both anchor sizes is only a conservative script-like rejection, not semantic classification or glyph proof. Compound fragments retain real text offsets and original whole boxes.

All three exposed-page v1 calibrations are retained separately: low/2000 was truncated; none/2000 was rejected; low/4000 produced a legal stage but failed original-image review. v2 has no new provider experiment and changes none of those outcomes. Unresolved reading order, ambiguous fragments, custom encodings and source position remain gaps; every stage stays manual-only and `sourceProven=false`.

The v2 path does not consume character metadata. The separate v3 path below accepts an already produced sidecar. The existing Docling environment has pypdfium2/PDFium; [PDFium's native text API](https://pdfium.googlesource.com/pdfium/+/main/public/fpdf_text.h) provides character boxes/origins/font information, while [pypdfium2 documents](https://pypdfium2.readthedocs.io/en/stable/python_api.html) index translation and threading limits. Character boxes do not certify mathematical semantics. No dependency, service or PDF parsing entry point was added.

## Character-backed v3 prototype

`pdf-character-style-staging.ts` is a separate pure policy. The v2 producer, plan,
candidate and stage are unchanged. It consumes the checked baseline, the existing
Poppler runs and the raw, SHA-verified PDFium character sidecar. No PDF is parsed
by this module, and it has no model, database or publication entry point.

Run association requires matching real decoded characters, font names and actual
character geometry. Boxes stay attached to their original `charIndex`; no run
rectangle is divided into estimated glyphs. Only unrotated, matching whole-page
frames are supported. Reported font size is combined with the actual transform,
and a font descriptor flag alone cannot establish bold. Unknown encodings,
conflicting style observations, ambiguous run association and script-like scales
are declined.

The v3.1 compatibility policy removes only a six-uppercase-letter PDF subset tag
and `+` when comparing font names, following [PDFium's source rule](https://pdfium.googlesource.com/pdfium/+/832a694e52c44e206598eff8c7d1797d47117d1b/core/fxge/cfx_fontmapper.cpp).
Original names and the normalization rule remain in each source association.
Multiple matching actual font names in one run are declined. Family aliases and
approximate font-name matching are not supported. The first v3 zero-operation
candidate, produced before this field-compatibility correction, remains archived.

The v3.2 policy also allows short native word windows across observed font/style
transitions. They retain consecutive original character IDs, actual Unicode and
boxes. Unknown/custom/control/generated characters or inconsistent forward,
vertically overlapping geometry split the source flow. Windows contain two to
eight words and must be unique in the available source segments and baseline
prose. The longest qualifying window around each real font transition is chosen
deterministically, with earliest original position as tie-breaker. No target or
expected repair participates in that choice. A union box is only a geometric
hint. These windows do not reconstruct native whole-page reading order or replace
baseline text. The v3.1 candidate and its source snapshot remain unchanged.

V3.3 adds the complete observed physical character segment as an additional
anchor, with a hard 512-byte UTF-8 limit and no truncation. It must map uniquely
as a whole to baseline prose and to the available continuous native segments.
All original indices and boxes, including actual whitespace, remain attached.
The same geometric `before` rule is unchanged. Shared anchor edges compare their
actual non-whitespace boundary characters, while retaining the complete source
geometry. This does not prove column or logical reading order. Both earlier
22-operation candidate versions remain archived without replacement.

The character producer can report an unknown Unicode pair as `null/null` or
`0/null` (codepoint/text). Such a record keeps its original raw bytes and index,
is declined as undecodable, and breaks the eligible character flow. A non-null
declared character/codepoint disagreement or changed index/source identity still
rejects the input. Unknown characters are never replaced or guessed.

The whole phrase of a real native run can form a short prose anchor when it has
at least two words and is unique in both source and baseline. Double-sided anchor
intervals restrict math-leaf correspondence. Repeated prose and math atoms inside
one interval cannot choose one another. Unique native prose phrases, or phrases
uniquely located between neighboring anchors, can add owned Markdown bold or
italic wrappers around identical existing baseline text. Existing TeX structure
and prose bytes are preserved, and inverse removal must recover all old bytes.
Upright scripts are explicitly unsupported. No native concatenated text replaces
the baseline.

All v3 stages remain `sourceProven: false`, `alignmentVerification: unverified`,
`requiresManualReview: true` and `notForApplyPageRepair: true`. Algorithm eligibility
and valid reversible construction do not prove same-occurrence correctness,
semantic decoding, complete font coverage or full-page fidelity.

### Exposed-page calibration and delivery status

The v3.3 algorithm selected all 23 eligible pairs without manual filtering or
additions. Independent review compared the original 1932 × 2500 PNG and actual
character indices/boxes with every selected occurrence: 23/23 selected wrappers
matched their own positions, comprising 10 vector-bold, 9 heading/label-bold and
4 prose-italic wrappers. The specified fifth italic occurrence (inline `S`) was
already represented in the baseline. Ten existing vector-arrow associations and
the specified three `S` domains plus two closed-integral marks remained intact;
these were preserved, not newly reconstructed. Byte-exact inverse recovery and
the original baseline/derived hashes were also independently checked.

This is one previously exposed page and a bounded style-position review. The full
page still **fails**: upright `enc` remains unsupported, two inherited en dashes
remain em dashes, and original layout, heading sizes, columns, spacing and exact
rendered symbol geometry are not restored or certified. No all-punctuation,
all-font, multi-page, new blind-group or general PDF/OCR accuracy claim follows.

Local evidence (ignored research assets, retained without rewriting old scores):

- Candidate manifest `data/native-style-algorithm-candidate-v3-whole-segments/manifest.json`:
  `e9c7b1b1a86ec1b61d192d8dbd0dcb1134b3db40ea37abd73c38c45e4f7c9741`.
- Baseline UTF-8 text: `3d3a608c5da3643b6817e020490587c60fabca3448520d30c9021300191d9768`;
  staged text: `bd26d56ede2b653a1e30624ec7293b6c001c94eef83d0bb80ef181aacea6eb33`.
- Independent `planned-study-answer/data/pdf-style-v3-independent-review.json`:
  `4a012d7441cc5a0d4159b89b9666a39981420f0c1333c600c3efd3a6b2f44e81`.
- `nullable-source-delta.json` binds the final producer-compatibility change to
  that unchanged candidate. All 2385 calibration records have non-null Unicode
  and codepoints, so the nullable-only route does not change their behavior; the
  candidate was not regenerated for this compatibility fix.

Five focused v3 tests passed without skips, including producer unknown values,
source identity, source-versus-math ambiguity, real box/size use, reversible
wrappers, continuous style transitions and an unknown/generated gap. TypeScript
checking passed. The pure tool is implemented; its final CI is reported on PR140.
No candidate was applied, no service was deployed, and production was not switched.
