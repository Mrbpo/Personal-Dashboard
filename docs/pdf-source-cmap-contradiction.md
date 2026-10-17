# Explicit source CMap contradictions (Issue #157)

This opt-in input preparation does not certify page fidelity. It makes a derived
parser PDF and a source-bound proof; the original PDF, font program, content
streams, original CMap, recognition raw responses and old versions remain intact.
There is no page/title/question/answer match and no AI/OCR step in this helper.

## Required independent evidence

`source-font-reference-v3` permits a contradiction candidate only when all of
these checks succeed:

1. The existing symbolic simple TrueType rule proves the raw byte → GID from
   exactly one embedded Mac cmap (platform 1 / encoding 0, format 0 or 6), with no
   PDF Encoding override. Encoding slots do not supply Unicode.
2. The embedded `post` table is version 2 and its exact case-sensitive glyph name
   has one public Unicode scalar in the fixed official Adobe Glyph List.
   Name suffixes, name guessing, private-use values and multi-character names
   are not normalized into guesses.
3. An independent font has the exact same outline commands and unitsPerEm.
   The reference font SHA must differ from the embedded program SHA. Conflicting
   legacy canonical entries or another source glyph with a conflicting/unknown
   exact-outline name cause rejection.
4. The old ToUnicode value is an explicit single Unicode BMP value in a unique
   bfchar or singleton bfrange. Unsupported range/array/inherited/duplicate
   mappings are left unchanged. Every non-target mapping is checked again after
   the replacement; content and embedded-font hashes are preserved by the
   existing derivative checks.

This is a conservative supported subset, not a general PDF interpreter or font
semantics proof. Unknown cases retain their original mapping. In particular the
exposed `lscript` case has neither an AGL entry nor an independent exact outline
witness and remains unknown; it has not been re-extracted in this change.

## Asset and actual ingestion entry

`lib/assets/source-post-agl-outline-v1.json` includes the official AGL text and
its redistribution notice, plus two independently observed outline hashes,
UPEM and reference GIDs. It contains no font binary. Its Unicode identity comes
from the embedded post2 name and pinned AGL, not Symbol/Mac slots 73/70 or
private Microsoft Symbol slots.

- AGL commit: `4036a9ca80a62f64f9de4f7321a9a045ad0ecfd6`
- AGL UTF8 SHA256: `a3b2f61ced9f3644cc0d4ecde5c59df34ca286c689d9484a43a710a81c466789`
- Frozen association report SHA256: `39a45250419d4e5cd28a427d592e27f4ead9cb636cf3bc3b26c0f6a7997b4159`
- Asset file: 82,894 bytes; SHA256 `df6c47a8d90cb3a3e343859c02dc5b5db1b36aee70c1726c952e76db187c62c8`

An administrator must explicitly configure all three values:

```text
PDF_FONT_REFERENCE_POLICY=source-font-reference-v3
PDF_FONT_REFERENCE_DICTIONARY=<absolute path to source-post-agl-outline-v1.json>
PDF_FONT_REFERENCE_DICTIONARY_SHA256=df6c47a8d90cb3a3e343859c02dc5b5db1b36aee70c1726c952e76db187c62c8
```

`convertDocumentWithDocling` → `prepareSourceFontInput` supplies the actual
derived input to the existing native/Docling text path. The configured file is
size/hash checked. The parsed reference asset is separately canonicalized into
CAS (`52c79f56514b249743d17bd27f56bdccae89b350cdda03cfbb6e46fd80d46069` for
this asset); this canonical SHA is intentionally distinct from the file SHA.
The existing source-encoding receipt binds source hash, page indices, input hash,
full before/after CMap bytes, raw code, actual GID, source program, path/UPEM,
post name, exact AGL row and independent outline witness indices. The receipt
participates in parser/options identity and parsing provenance. The existing
cache replay reconstructs v3 with this exact CAS asset. Published provenance GC
retains its declared receipt and dictionary references.

The normal default remains v2; saved v1/v2 receipts still select their original
policy and do not repair already mapped values. Visual transcription uses the
original page images and is not claimed to benefit from a changed text CMap.
Nothing in this PR enables a production setting or migrates existing data.

## Bounded validation and limits

The initial `tests/pdf-source-agl.test.ts` run had **4 pass, 0 fail, 0 skip**.
An independent review then found that comments could be mistaken for active
CMap operators. v3 now shares an offset-preserving lexical view for reading,
replacement and final verification; it masks comments and literal strings while
preserving their original bytes. The added regression alone was run afterward:
**1 pass, 0 fail, 0 skip**. It checks repeated fake comment/string mappings and
an active contradictory mapping in the same stream. The four passed cases and
native extraction were not repeated.

The focused cases cover opt-in behavior, both supported CMap forms, non-target
preservation, unknown/conflicting evidence, unsupported/ambiguous mappings,
exact v3 saved-input replay, checksum rejection and CAS retention. Previously
passed source diagnoses and the old suite were not rerun.

The one exposed source page was prepared through the actual helper using the
new asset. Only that derived input received one native extraction using pypdf
6.10.0, plain `extract_text()` followed by the existing `strip()` normalization:

- Source SHA: `39d2860ac90ffe628e233e0f73729fc81ea20705b8d9e7dd74abd3513d440902`
- Derived input SHA: `eec20c9ae7868ce1768e255ab2bd78c4857319b74a62a7b8aa7f730711a3ee15`
- Frozen old body SHA: `fd469198f9e2328e3560d57a7c34bd2be2323711a2c79ee55306fe270f674586`
- New native body SHA: `8c92198772da6128c0e78d97c46aca7c3dc8a636a7a9509c7d00439b4dfcc581`

Both texts contain 1,531 codepoints: exactly five `s` → `σ` and one `p` → `π`;
the other 1,525 codepoints are unchanged. The two source-level CMap changes
affect these six occurrences. Raw native text, proof and receipts are retained
under the ignored `data/issue157-native-one/`; the original frozen body and its
score were not edited. This is component evidence on an already exposed page,
not a new blind result, full-page chemical-structure pass or corpus success.
No additional page, render, OCR, Docling, provider, PG write or production
operation was performed. Service deployment and production switching remain
**not performed**.
