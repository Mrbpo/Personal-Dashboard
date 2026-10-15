# Bounded original-page repair

This administrator tool stages selected-page visual transcription without running a whole-document reparse or changing the UI. Selected pages use the source/model/render/prompt-specific cache (`pdf-visual-selected-v3`). Formal Docling conversion also explicitly selects all original pages when it needs this visual branch, so it uses that same faithful policy and cache. The selected subset must have distinct valid original 1-based page numbers, up to the existing 24-page limit. The repair CLI is deliberately limited to two pages total and a maximum $0.236 conservative reservation per invocation. Existing monthly and 60-per-UTC-day limits remain enforced; there is no automatic retry or budget bypass.

A JSON plan contains `{owner,documents:[{documentId,sourceHash,expectedVersion,pageNumbers}]}`. The original blob checksum, owner, current PostgreSQL version and complete original page inventory are checked before recognition. Copying/rendering preserves original page identity. Only the original page image is sent to recognition; no query, gold answer or hand-authored formula is supplied. The fidelity prompt forbids correcting source spelling or mathematics and asks for standard delimited LaTeX in original reading order. A model's `complete:true` is not proof of faithful mathematics.

```text
node --experimental-strip-types scripts/repair-pdf-pages.ts --plan PLAN.json --result RESULT.json
node --experimental-strip-types scripts/repair-pdf-pages.ts --plan PLAN.json --result RESULT.json --recognize
```

The first command estimates effective rates, existing ledger balance, cached work and remaining daily quota without a model call. Recognition first checks that the result file is writable, saves each successful page and leaves the searchable head unchanged. Review the result against the original render for symbols, limits, signs, source typos, equation regions, reading order and LaTeX syntax. If it is unfaithful, retain the failure and stop; do not hand-edit the result to match a test answer.

Only after a faithful review:

```text
node --experimental-strip-types scripts/repair-pdf-pages.ts --plan PLAN.json --result RESULT.json --apply
```

Apply makes no model call. It accepts only the exact validated cache text and atomically publishes a complete new document version through KernelService, reusing the other current pages. A transaction-level current-version guard rejects concurrent changes. New page evidence stores the repaired page's model/parser or the unchanged page's previous method/model, with links to prior version/source/evidence. Old versions and evidence remain. A partial multi-document apply is recorded after each complete document; a resume verifies the recorded whole current version and text hashes before skipping that document. It cannot skip based solely on a status marker.

## Formal visual policy and original images (Issue #119)

Formal visual conversion passes the verified original SHA and explicit original page numbers to the existing v3 implementation. It does not change that implementation's provider prompt, configured model, rendering configuration, output limit or incomplete/structure checks. An old `pdf-visual-v1` cache remains historical; it is not certified or reused as v3, and no background backfill is scheduled. A matching v3 entry can be reused without another provider request. Native text and Docling parsing decisions remain as before.

Before repair publication, the existing current/source-bound image reader retrieves the full verified layout with an empty image selection. It checks the whole immutable manifest and bindings without loading answer images, so documents with more than 64 stored page/region images do not silently lose assets or widen the answer reader's 64-image limit. The existing visual staging process then verifies the actual original PDF, saved Docling region references and cached PNG blobs outside the transaction. All regions and original page pixels are rebound to the replacement version's new page evidence during the same short CAS transaction as its text. No old anchor binding is copied to the new version.

If no prior layout exists, it is explicitly unavailable and genuine whole-page PNGs are prepared from the original PDF. If the renderer cannot supply the complete original page images, repair stops and keeps the previous current version. A source/version change also rejects publication. These are wiring and provenance checks; preserving page images or using a stronger prompt does not establish mathematical transcription fidelity. Real recognition acceptance and deployment remain separate steps.

## Actual isolated check (2026-10-14)

The source targets were only MIT 6.867 lecture 8 original page 2 and problem-set-4 solutions original page 1. The existing complete documents contain 5 and 8 pages respectively; other pages were neither recognized nor republished.

- Local visual/helper mocks passed; actual temporary PostgreSQL schema checks passed **2/2, zero skips**, covering old-page/evidence retention, atomic publication, current-version rejection, exact completed-work verification and preservation of a prior repaired page's model/parser. TypeScript and targeted lint passed.
- First recognition attempt encountered an isolated output-directory permission error after one successful cached page. The directory ownership was corrected and the cached page reused; no duplicate recognition charge occurred. The CLI now checks staging writeability before spending budget.
- Fidelity v1 used two actual requests, settled at **$0.006608**, and failed manual fidelity/LaTeX review. It changed an original repeated Gamma(a) denominator to Gamma(b), and produced invalid/bare math commands.
- The coordinator authorized exactly two additional generic fidelity-v2 requests, with a distinct cache/result file. They settled at **$0.007701** and also failed: source math was still corrected and lecture display/inline formatting remained inconsistent. Initial outputs were retained, not overwritten.
- Total: **four requests / $0.014309**. Isolated ledger used $3.71975054 of its unchanged $5 cap, leaving $1.28024946; daily visual allowance remaining 56. No further requests were made.

**Code:** bounded helper/CLI and provenance guard implemented. **Tests:** focused code checks passed; the two real recognition attempts did not pass source-fidelity acceptance. **Services deployed:** PDF application changes not deployed. **Production switched:** not switched by this work. No known-unfaithful recognition result was applied; that recognition check left the parsed heads unchanged. Neither the fresh retrieval gate nor global formula fidelity is certified by this check.

## Cached original-text recovery (2026-10-14)

A separate zero-model investigation found that existing Docling formula nodes had empty `text` but nonempty `orig`. The common decoder now prefers nonempty normalized text, otherwise preserves `orig` verbatim in the existing reading order and page provenance. This includes rich table references; unreferenced original-only text cannot silently disappear. Formula `orig` is raw source extraction, not verified LaTeX: it is not wrapped in display-math delimiters, and an explicit warning remains. It can still contain flattened or missing symbols and subscripts.

The administrator recovered only the two original pages above from already saved result blobs, checking the original SHA, cached-result SHA, deterministic copied-page input SHA and exact original page mapping. No Docling or AI request was made. Complete new 5/8-page document versions were atomically published through the existing current-version guard, preserving the other pages and linking each page to its prior source/version/evidence. The recovery script records completed documents; resuming a partial apply verifies the exact new head, complete reviewed text hash and changed/unchanged pages before skipping completed work.

| Document / original page | Before / after characters | Restored raw formula blocks | New isolated current version |
| --- | --- | --- | --- |
| Lecture 8 / 2 | 1333 / 1802 | 7 | `8500c13d6f728fe996c458838addc0179e4a042a989d2f3c14ed7bb323320bb1` |
| Homework 4 solutions / 1 | 1121 / 1763 | 9 | `384aa06d65330be4f9ff2b7ef076c993c3221c1953d43418ae806636a054d1a1` |

The printed repeated `Γ(a)Γ(a)` was preserved, unlike the rejected recognition results. Native glyph inspection finds 26 ψ characters on the solutions page, while the recovered Docling page still has only one; inline-symbol coverage remains incomplete. Native text also has unmapped operator characters and flattened math order, so it is a useful source-derived sidechannel rather than a complete LaTeX transcription.

The initial upload approval block was resolved after reviewing the same three files and destination against the existing authorized isolated-server task. Repository source remains private. Original PDFs, cached raw results and all four failed recognition outputs remain; no gold answers were edited. This recovery cost **$0** beyond the previously recorded $0.014309. Decoder checks passed **10/10**, TypeScript and targeted lint passed. **PDF services deployed: no. Production switched: no.** Only isolated current text versions changed; fresh retrieval and formula-fidelity acceptance are separate gates.

Read-only audit found that persisted version warnings were dropped before synthesis. The follow-up code carries optional `parser_warnings` from the current PostgreSQL version through lexical/dense/adjacent hits, strict and regular library search, archive/tutor sources, API results and citation metadata. Legacy sources default to `[]`. Actual course-Q&A and tutor model inputs include the source warnings; fixed developer instructions forbid asserting unverified formulas as exact originals or inventing missing symbols, while allowing supported prose answers. Two focused zero-network checks verify wrapper propagation and the actual mocked model request. This is a metadata/synthesis change, not a UI change, mathematical-fidelity certification or completed fresh retrieval gate; PDF application changes remain undeployed.
