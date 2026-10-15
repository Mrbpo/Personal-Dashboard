# Development complete-answer diagnostics

Issue #129 adds `KernelService.auditSelectedStudySourceAnswer(owner, question, expectedSource, binding, policy)` alongside the unchanged citation-local auditor. It is never called by default and does not repair answers or write canonical data.

`binding` contains the original `inputFingerprint`, `quoteUnitManifestSha256` and full `providerSelections`. Kernel reads the current complete source and restores every original citation. The fixed development policy requires both durable `beforeAttempt` and `recordResponse` callbacks and the existing isolated administrator environment. One `gpt-5.4-mini` / low / 4000-token / 30-second request is permitted per invocation; this code grants no authorization to run a paid pilot.

The request includes the entire source quote-unit input, original PNGs, complete-source manifest and limitations, original answer (including an original refusal message), and each selected citation's original claim/position binding. It contains no expected answers or prior judgments. The actual serialized developer/schema/text input, original-image token bound and existing framing allowance must fit the unchanged complete-source request cap before any attempt or reservation. Overflow returns `unavailable` with its request accounting; source and answer are never shortened to fit.

Diagnostics keep three views separate:

- `localSupport.cN.citationFindings.rN`: exactly every original claim and citation position. Other source evidence cannot establish support for a wrong selected citation.
- `coverage`: question-relevant omissions against the supplied complete context, including a refused or empty original answer. Omissions require real selectable source-unit/image IDs.
- `scopeAndConflicts`: requested versus answered scope, and both real source statements for potential disagreements, distinguishing comparable same-target claims from different contexts or unresolved comparability.

Source IDs are validated against the actual input allowlist. The schema shares citation findings rather than repeating a full-source enum per claim. Current source/answer bindings are rechecked before inference and after the durable raw-response callback. Incomplete responses, invalid diagnostics, unknown model/usage and changed sources fail without repair or retry. A timeout retains the ordinary pending reservation and cannot invent a raw response.

The v2 diagnostic explicitly supplies the selectable `allowedSourceIds` namespace and uses one shared `$defs/sourceId` enum for every output source-ID field. `eN` support IDs remain labelled metadata only, including the original answer's citation metadata; they cannot substitute for selectable `q:` units or actual supplied image IDs. Schema enum overflow fails before reservation. No old invalid IDs are mapped or repaired.

A per-citation `supports` finding means the selected reference establishes at least one material assertion, not necessarily the whole claim; `does-not-establish` means it establishes none. Several partial references may jointly support the aggregate. Aggregate `supported` requires all material assertions to be established collectively by the actual selected citations, without unresolved contradiction. Its reason and evidence-scope description cannot borrow unselected full-source evidence. The validator rejects a supported aggregate with no supporting reference or with any contradiction; it never changes the verdict or rejects legitimate combinations merely because no individual citation establishes the entire claim.

The result preserves the original answer, selections, restored citation bindings, source/quote manifests, request identity and raw-response hash. Valid structure, accepted IDs or a model's `complete` judgment do not establish semantic correctness. Independent review remains required; no benchmark score, deployment or production switch follows from this diagnostic.
