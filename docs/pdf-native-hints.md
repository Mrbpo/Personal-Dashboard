# Optional native PDF text-run hints

Issue #134 adds an opt-in input to the existing selected-v3 visual transcription. It does not certify transcription accuracy or publish native hints as Kernel evidence/facts.

## Enablement

The default remains disabled. A trusted administrator can set `PDF_VISUAL_NATIVE_HINTS=poppler-text-runs-v1` for the Docling visual route, or a trusted application caller can set `nativeTextHints: 'poppler-text-runs-v1'` on `transcribePdfVisualPages`.

The mode requires selected physical pages, `gpt-5.4-mini`, successful original PNG rendering and no tiling. For the Docling visual route this also requires `PDF_SCAN_TRANSCRIPTION_BACKEND=ai`, `DOCLING_NATIVE_TEXT_FASTPATH=false` and `PDF_VISUAL_IMAGE_INPUT=true`. This is a development opt-in, not a production configuration change.

The ingestion job freezes the policy in its payload and has a separate idempotency key. Old jobs lacking this field stay disabled, even if the worker environment changes. Existing default payloads, cache keys and raw results remain unchanged. Old Docling task/progress is preserved only when all recorded extraction settings, including this policy, match.

## Source contract

The producer loads the full original bytes once and verifies their SHA256. Each sidecar binds:

- Full input PDF SHA256 and original physical page number.
- Actual PNG SHA256/dimensions; original MediaBox, CropBox, rotation and UserUnit.
- Actual Poppler version, fixed argument policy and XML SHA256.
- Native text-run rectangles, reported font fullnames/sizes and observed bold/italic markup spans.

The first version supports coincident MediaBox/CropBox at origin zero, zero rotation and UserUnit 1. It does not invent other transforms. Coordinates are top-left points at zoom 1; the PNG scales are explicit. Unsupported geometry, missing producer, warnings, unsafe/unsupported XML, unknown fonts, zero native text or byte overflow produce an explicit `unavailable` packet without partial runs.

The serialized sidecar has a hard 64 KiB UTF-8 cap. XML has a separate 256 KiB capture cap and 30 second process timeout. XML is read through a closed local grammar; DTD/entity loading, network resolution and HTML execution are absent. Only the exact inert Poppler doctype is permitted. Neither `-hidden` nor `-nodrm` is used.

These are text-run rectangles, never glyph boxes. Compound runs stay compound. Reported font fullnames do not certify a font file, and no host replacement is assigned as an original font. Observed style tags do not infer vector, subscript or superscript semantics. Custom mathematical encodings can remain wrong; the original PNG remains necessary.

## Cache and audit

Only the new policy uses a separate envelope in the existing SQLite parse cache. Its identity includes source/page, actual sidecar (including producer availability/output and PNG identity), model and base prompt policy. The envelope stores the sidecar, exact actual request SHA256, successful HTTP raw text/SHA256 and resulting text. It does not duplicate the base64 PNG. Cache reuse rebuilds the request and verifies its hash, raw identity, terminal completed/error-free status, supported model and text derivation. A corrupt existing entry is preserved and rejected without an automatic provider retry.

No new audit store or Kernel provenance schema is introduced. A failed call creates no successful cache. Development calibration must use the existing durable runner: persist actual wire before sending, persist HTTP status/raw before parsing (including failures), retain reservations on ambiguous failure, and stop without retry. A missing raw response cannot count as a result.

## Proposed exposed-page calibration (not executed)

Use only the already exposed MIT `summary_w02d2` physical page 1:

- Public URL: <https://ocw.mit.edu/courses/8-02-physics-ii-electricity-and-magnetism-spring-2007/40dfe778b10f19d6b7f7821d779e3242_summary_w02d2.pdf>.
- Full upstream PDF SHA256: `aef94153ed5d9b79e3cc2620746ab7c0f78249385e68c488f957bfd9c23ddf44` (2 pages). Select only physical page 1; do not parse page 2.
- Existing formal PNG SHA256: `9ce5df9749cd809f44b79b4260afef240850143c845566efcdc445cc72d8a222`. Verify the newly constructed request uses identical PNG bytes or stop and report the difference.
- Existing probe XML SHA256: `776cdda3f5130dcb86d1d25dacd26579ab4d4c2f9b70d76364b7bcc2a8e6a27c`. That probe used the separately identified one-page derivative SHA256 `3e44b20a38738025bf4b333984d551c494551d4f3163bf641da6f0eaed2a4b44`; do not relabel its XML as a fresh full-upstream producer result. The proposed collector runs once on the full original with `-f 1 -l 1` and records actual XML identity.
- Pin the final reviewed commit and existing runtime `sha256:8ba54ed74db6eb2438c6c2d60541c21f49414c9442a563704763202728539e34`; no dependency installation or new service.
- One new request maximum, `gpt-5.4-mini`, allowed actual snapshot `gpt-5.4-mini-2026-03-17`, low effort, original image detail, max 9000 output tokens. Same selected-v3 base prompt/schema; only the new source-bound native sidecar is added.
- First freeze actual wire, sidecar, source/PNG/producer identities and conservative existing rate/context funding bound. Proposed development-only hard cap USD 0.35; no normal-operation budget change, retries, escalation or alternate provider. The parent must review and authorize execution separately.
- A dedicated isolated SQLite/cache phase can call the formal parser for selected page 1; no PostgreSQL/production writes, Docling request, embedding, rerank or answer synthesis. Existing raw, output, scores and blind qualifications remain unchanged.
- Compare actual stored text with the original page for prose, all formula base symbols/operators/scripts, bold versus arrow/hat distinctions, and any regressions. Known exposed observations may guide review, but no expected symbol list or old answer enters the provider request. Completion/schema validity alone is not fidelity.

Implementation tests use synthetic PDFs and mocked local processes/provider only. A single exposed-page improvement is not full-document fidelity, a new blind group, or three independent successful groups.
