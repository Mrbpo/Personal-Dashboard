# Flat persisted text context

Issue #137 addresses ordinary text sources without a registered structure. Only `readDocumentParents` may derive a deterministic `parents=[]` manifest from the current PostgreSQL text/evidence nodes. It writes no structure, body, source head, evidence, fact or vector. Existing registered structures retain their original validation and immutable identity; a later explicit author structure can still be registered.

Eligibility requires exact `text/plain`, a general text/plain/JSON parser or extraction declaration, and no PDF/Docling/OCR/vision/formula/layout conversion declaration. Unknown and complex sources remain unavailable. No benchmark name, owner, origin or filename selects this behavior. Current owner/version/source/evidence/body checks and the final source recheck remain mandatory; source changes are never swallowed.

The derived manifest says only what text nodes are currently persisted. Each returned flat parent carries `flat-persisted-text-v1` provenance, its derived manifest hash, `originalHierarchyVerified=false` and `originalFileCompletenessVerified=false`. These fields enter the prepared provider input and fingerprint and the answer receipt. Existing parser warnings are retained. Flat context neither invents author sections/geometry nor certifies that extraction covered an original file.

Strict outline, image registration and complete-source readers do not enable the fallback. A missing original structure still produces their existing unavailable/error result. Original registered images/sections and their request bytes remain unchanged.

One focused actual PostgreSQL scenario covers mixed flat/registered sources, exact nodes and warnings, provenance/fingerprint/receipt, no persistence, later author registration, strict/complex refusals and concurrent hiding. It uses no model/Docling calls. No old library backfill or six-query benchmark rerun is part of this change. Code and CI completion are separate from semantic acceptance, deployment and production switching.
