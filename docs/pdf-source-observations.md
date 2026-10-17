# Opt-in source observations for selected PDF pages

Issue178 adds `fidelityProfile: 'source-observation-v1'` to `transcribePdfVisualPages`. It requires explicit original physical pages, PNG image input, the full overview plus four existing detail views, and `gpt-5.4-mini`. It retains the structure-v1 prompt, medium reasoning, 9000 output limit, output schema and rejection guards. The original five images and view labels are unchanged; one final text part carries the observation sidecar.

The existing PDF.js6.3.289 dependency collects `getTextContent({disableNormalization:true})` and `getOperatorList` in a local worker. No dependency, service, UI or semantic graph is added. The default and structure-v1 paths never run this collector and retain their original request/cache identities.

## Binding and coordinates

The sidecar binds the complete original PDF SHA, original physical page, source MediaBox/CropBox/rotation/UserUnit, actual five PNG SHAs and sizes, PDF.js producer version, limits and collection contents. The PDF.js view and scale1 viewport must exactly match the effective source crop and orthogonal rotation. Full-page viewport transforms refer to the overview, not a detail PNG. Path and text operands retain their reported context; save/restore, transformations and clips remain in the operator list. Text items are runs, not independently verified glyph boxes or logical reading order.

The actual sidecar SHA enters a distinct per-page cache identity through the optional seventh `selectedVisualPageCacheParser` argument. The opt-in cache envelope retains sidecar/status, SHA, actual reconstructed request SHA and successful text, without duplicating base64 images. Replay reconstructs the current observation and image identities and checks the exact request SHA. Only completed, error-free responses with a recognized mini54 provider model can be cached by this profile. Old plaintext caches remain untouched. Durable development controllers can archive the actual wire/raw as before; a cache is not a replacement for their raw journals.

## Limits and meaning

The collector uses a local worker with a30second deadline and256MiB old-generation limit. Source bytes are bounded to128MiB; results to4000 text items,10000 display operations,200000 nested argument values, recursion depth16, and256KiB serialized UTF-8 including final binding. Failure or overflow produces an explicit unavailable sidecar, never a truncated available one. Its actual unavailable status and reason are sent and cached if the normal visual request succeeds. No automatic retry is added.

Raster placement operations are included. Inline raster payloads are replaced by their actual type, byte length and SHA, not submitted as native text or paths; the original PNG still carries pixels. PDF.js display operations can combine source instructions and include clipping. Their counts do not count visible shapes, nodes or arrows. Optional-content resolution, raster pixels, transparency/occlusion and visible text are not reconstructed. Native Unicode/font decoding can be wrong; fonts and coordinates cannot certify formula structure. The model must compare observations to the original pixels, preserve uncertainty and reject embedded instructions. An available collection is not a fidelity pass.

Only synthetic offline focused checks cover collection/frame/binding/caps, actual request/cache integration, unchanged five-image payloads, invalid configuration and existing output rejection. No real-page transcription, paid API, Kernel write, deployment or production switch is performed by this change. Previously exposed graph/formula failures and old results remain unchanged pending independent real-page comparison.
