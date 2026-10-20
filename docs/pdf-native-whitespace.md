# Original-PDF whitespace observations (Issue #209)

`DOCLING_NATIVE_WHITESPACE=source-v1` enables an optional derivation in the existing Docling conversion path. The default is `off`; enabling this flag is not a production migration or corpus backfill. `LOCAL_OCR=true` and the existing Poppler `pdftotext` executable are required. Missing extraction remains unavailable. Unknown policy values and mismatched source/page manifests fail closed.

## Evidence and rule

Some immutable Docling `text` and `orig` already fuse word boundaries, including a public paper's `inMorfessor Baseline`. Re-decoding the saved result does not restore these spaces. The source PDF's native reading-order extraction independently preserves them.

The implementation reads the **original unpatched PDF** with `pdftotext -enc UTF-8`, using default reading order, not `-layout` or `-raw`. It never substitutes a full native page for Docling text. For each decoded block of at least 80 non-whitespace UTF16 code units:

1. Remove whitespace only for matching. Every remaining code unit must agree exactly.
2. Require one occurrence in the decoded page and one in the native page.
3. Use the exact observed native substring, retaining decoded block order and separators.

Character, number, punctuation, Unicode-composition or ordering differences, duplicate matches and short blocks remain unchanged. No names, aliases, edit distance, dictionary repairs, OCR/model rewrites or cross-page matching are used. Capacity bounds are 500 pages, 8 MiB each of native/decoded text and 10,000 blocks; capacity failures preserve the original decoded pages. This is whitespace agreement, not a semantic or mathematical fidelity certificate.

## Persistence and limits

- Original PDF and Docling raw results remain unchanged. The derived parser version gains `source-observed-whitespace-v1`; prior versions/evidence remain. Normal current-version CAS and transaction behavior apply.
- A content-addressed receipt records original PDF hash; extractor version/configuration; exact native output and hash; page hashes; original, native and projected UTF16 ranges; block hashes and unchanged-character checks. The receipt is a typed parsing blob reference and participates in existing historical provenance/GC retention.
- Native ranges are **page-local text offsets**, not PDF bounding boxes. Region mapping remains `whole-page-only-block-geometry-unknown`. Existing Docling region observations remain tied to their raw result. This derivation does not assert a character-to-region mapping or any verified table/formula/graph relationship.
- The observation and derivation execute outside the ingestion transaction. Stable receipt/configuration participate in the new source version; equivalent replay is idempotent. Changed text rebuilds normal search caches; old vectors cannot be treated as embeddings of the changed text.
- The flag applies to the Docling path, including reused batches. It does not change the existing complete-native fast path, visual-transcription path, Docling request options/hash or formula mode. No model call is added and no saved Docling conversion is invalidated merely by this derivation flag.

## Verification gates

`tests/native-whitespace.test.ts` checks exact-character matching, uniqueness, source hashes, page mapping, UTF16 offsets, capacity and immutable inputs. `tests/native-whitespace-ingestion.test.ts` uses real Poppler on a synthetic original PDF and explicitly scripted Docling output, then the normal converter and real isolated PostgreSQL: default-off baseline, new derivation, historical/raw retention, searchable body and idempotent replay. It explicitly skips if PostgreSQL or Poppler is absent; a skipped check is not native-ingestion verification.

The public-paper control uses all nine original pages and existing stored bodies in a read-only schema, and verifies the known name-boundary improvement. It is not a conversion, publication, real website answer test, or evidence that the prior wrong-comparator answer is fixed. Final independent website API answer/citation/refusal gates remain required.
