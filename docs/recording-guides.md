# Reviewed recording learning guides

The existing recording page exposes a learning-guide entry only when the selected original has a reviewed asset manifest. This release serves existing assets; it does not enable an automatic generation engine or paid requests.

Set `RECORDINGS_GUIDE_DIR` to the server-managed asset directory. The recording Compose overlay uses `/app/data/recording-guides` in the existing persistent data mount. For each original SHA, publish `manifest.json`, `guide.html`, `guide.pdf`, `outline.pdf`, and `outline.txt` in a SHA-named directory. Keep private materials outside Git.

The manifest declares schemaVersion 1, the original videoSha256, clipStartMs/clipEndMs, reviewed=true, and sha256/bytes for each fixed html/pdf/outlinePdf/outlineText asset. Files must resolve inside the configured root. Downloads verify size and SHA; mismatched originals, invalid coverage and unreviewed bundles fail closed. Coverage metadata is explicitly partial when it does not span the known original duration.

Owner-protected `GET /api/recordings/:viewId/guide` returns availability and coverage. `?format=html|pdf|outlinePdf|outlineText` serves fixed assets; `&download=1` requests attachment delivery. The HTML viewer rewrites the published template's download links through the same authenticated route, disables scripts/remote resource loading, and embeds original images as data URLs. No public static directory or bucket access is added.

Published learning content follows original image, collapsed bilingual transcript, and detailed teaching explanation, followed by an outline. The generation input uses original images and English ASR only; translated subtitles are display material. This serving feature does not establish generated-content accuracy or full-course coverage.

Verification: one focused original/coverage/asset-integrity test; type checking, targeted lint and production Webpack build; ten real local HTTP checks; browser entry, image loading, native transcript expansion and English/Chinese pairing. Private screenshots remain local. Independent review identified stale metadata when revisiting a view after a failed load; the guide component now remounts for each selected view.

Release state is separate from code completion. The existing CI/release process must pass before deployment, assets must actually be installed, and authenticated production downloads must be checked afterwards. No database migration or PDF question-answering change is included.
